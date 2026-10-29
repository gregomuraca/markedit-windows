use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub const LIMIT: u64 = 20 * 1024 * 1024;
pub type Result<T> = std::result::Result<T, String>;

#[derive(Default, Debug, Clone)]
pub struct Document {
    pub path: Option<PathBuf>,
    pub bom: bool,
    hash: Vec<u8>,
}

fn read_bytes(path: &Path) -> Result<Vec<u8>> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > LIMIT {
        return Err("This version supports files up to 20 MB.".into());
    }
    let mut bytes = Vec::new();
    file.take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > LIMIT {
        return Err("File exceeds 20 MB.".into());
    }
    Ok(bytes)
}

impl Document {
    pub fn is_mermaid(&self) -> bool {
        self.path
            .as_ref()
            .and_then(|p| p.extension())
            .and_then(|s| s.to_str())
            .is_some_and(|ext| {
                ext.eq_ignore_ascii_case("mmd") || ext.eq_ignore_ascii_case("mermaid")
            })
    }
    pub fn read(path: &Path) -> Result<(Self, String)> {
        let path = fs::canonicalize(path).map_err(|e| e.to_string())?;
        let bytes = read_bytes(&path)?;
        if bytes.contains(&0) {
            return Err("This file is not UTF-8 text. Convert it to UTF-8 before opening.".into());
        }
        let bom = bytes.starts_with(&[239, 187, 191]);
        let text = std::str::from_utf8(if bom { &bytes[3..] } else { &bytes })
            .map_err(|_| "This file is not valid UTF-8 text. Convert it to UTF-8 before opening.")?
            .to_owned();
        Ok((
            Self {
                path: Some(path),
                bom,
                hash: Sha256::digest(&bytes).to_vec(),
            },
            text,
        ))
    }

    pub fn changed_on_disk(&self) -> Result<bool> {
        let Some(path) = &self.path else {
            return Ok(false);
        };
        match fs::read(path) {
            Ok(bytes) => Ok(Sha256::digest(bytes).as_slice() != self.hash),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn write(&mut self, path: &Path, text: &str) -> Result<()> {
        let bytes = if self.bom {
            [b"\xef\xbb\xbf".as_slice(), text.as_bytes()].concat()
        } else {
            text.as_bytes().to_vec()
        };
        if bytes.len() as u64 > LIMIT {
            return Err("Save supports files up to 20 MB.".into());
        }
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
        temp.write_all(&bytes).map_err(|e| e.to_string())?;
        temp.as_file().sync_all().map_err(|e| e.to_string())?;
        // tempfile uses the platform's replacement operation; never delete the original first.
        temp.persist(path).map_err(|e| e.error.to_string())?;
        self.path = Some(fs::canonicalize(path).unwrap_or_else(|_| path.to_owned()));
        self.hash = Sha256::digest(bytes).to_vec();
        Ok(())
    }

    pub fn attach_image(&self, name: &str, bytes: &[u8]) -> Result<String> {
        let ext = Path::new(name).extension().and_then(|v| v.to_str())
            .unwrap_or("").to_ascii_lowercase();
        if !["png", "jpg", "jpeg", "gif", "webp", "bmp"].contains(&ext.as_str()) {
            return Err("Choose a PNG, JPEG, GIF, WebP or BMP image.".into());
        }
        if bytes.is_empty() || bytes.len() as u64 > LIMIT {
            return Err("Images must be between 1 byte and 20 MB.".into());
        }
        let base = self.path.as_ref().and_then(|p| p.parent())
            .ok_or("Save the document before attaching an image.")?;
        let base = fs::canonicalize(base).map_err(|e| e.to_string())?;
        let assets = base.join("assets");
        fs::create_dir_all(&assets).map_err(|e| e.to_string())?;
        let assets = fs::canonicalize(assets).map_err(|e| e.to_string())?;
        if !assets.starts_with(&base) {
            return Err("The assets folder must be inside the document folder.".into());
        }
        let mut file = tempfile::Builder::new().prefix("image-").suffix(&format!(".{ext}"))
            .tempfile_in(assets).map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.as_file().sync_all().map_err(|e| e.to_string())?;
        let filename = file.path().file_name().unwrap().to_string_lossy().into_owned();
        file.keep().map_err(|e| e.error.to_string())?;
        Ok(format!("assets/{filename}"))
    }

    pub fn image(&self, source: &str) -> Option<String> {
        if source.len() > 4096 {
            return None;
        }
        let decoded = percent_encoding::percent_decode_str(source)
            .decode_utf8()
            .ok()?;
        if decoded.contains(':') || decoded.starts_with(['/', '\\']) {
            return None;
        }
        let base = fs::canonicalize(self.path.as_ref()?.parent()?).ok()?;
        let file = fs::canonicalize(base.join(decoded.as_ref())).ok()?;
        if !file.starts_with(&base) {
            return None;
        }
        let ext = file.extension()?.to_str()?.to_ascii_lowercase();
        let mime = match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            _ => return None,
        };
        Some(format!(
            "data:{mime};base64,{}",
            STANDARD.encode(read_bytes(&file).ok()?)
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn attachments_are_local_unique_and_previewable() {
        let dir = tempfile::tempdir().unwrap();
        let mut doc = Document::default();
        assert!(doc.attach_image("photo.png", b"image").is_err());
        doc.write(&dir.path().join("notes.md"), "# Notes").unwrap();
        let first = doc.attach_image("photo.png", b"image").unwrap();
        let second = doc.attach_image("photo.png", b"other").unwrap();
        assert_ne!(first, second);
        assert!(first.starts_with("assets/image-"));
        assert_eq!(fs::read(dir.path().join(&first)).unwrap(), b"image");
        assert!(doc.image(&first).unwrap().starts_with("data:image/png;base64,"));
        assert!(doc.attach_image("bad.svg", b"<svg/>").is_err());
        assert!(doc.attach_image("empty.png", b"").is_err());
        assert!(doc.attach_image("big.png", &vec![0; LIMIT as usize + 1]).is_err());
    }
    #[test]
    fn unicode_bom_crlf_roundtrip_and_replace() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("notes.md");
        let mut doc = Document {
            bom: true,
            ..Default::default()
        };
        let text = "# Café 🌱\r\n日本語\r\n";
        doc.write(&p, text).unwrap();
        let (mut read, actual) = Document::read(&p).unwrap();
        assert_eq!(actual, text);
        assert!(read.bom);
        assert!(!read.changed_on_disk().unwrap());
        read.write(&p, "replacement").unwrap();
        assert!(doc.changed_on_disk().unwrap());
        assert_eq!(Document::read(&p).unwrap().1, "replacement");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }
    #[test]
    fn detects_delete_invalid_utf8_and_binary() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("note.md");
        let mut doc = Document::default();
        doc.write(&p, "hello").unwrap();
        fs::remove_file(&p).unwrap();
        assert!(doc.changed_on_disk().unwrap());
        for bytes in [vec![255, 254, 253], vec![0, 1, 2]] {
            fs::write(&p, bytes).unwrap();
            assert!(Document::read(&p).is_err());
        }
    }
    #[test]
    fn failed_save_preserves_state_and_cleans_tempfile() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("folder.md");
        fs::create_dir(&p).unwrap();
        fs::write(p.join("keep"), "original").unwrap();
        let mut doc = Document::default();
        assert!(doc.write(&p, "replacement").is_err());
        assert!(doc.path.is_none());
        assert_eq!(fs::read_to_string(p.join("keep")).unwrap(), "original");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }
    #[test]
    fn image_scope_blocks_remote_parent_svg_and_windows_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("notes");
        fs::create_dir(&base).unwrap();
        fs::write(base.join("x.png"), [1, 2, 3]).unwrap();
        fs::write(dir.path().join("secret.png"), [4]).unwrap();
        fs::write(base.join("x.svg"), "<svg/>").unwrap();
        let mut doc = Document::default();
        doc.write(&base.join("note.md"), "").unwrap();
        assert!(doc
            .image("x.png")
            .unwrap()
            .starts_with("data:image/png;base64,"));
        for source in [
            "../secret.png",
            "%2e%2e/secret.png",
            "https://example.com/x.png",
            "x.svg",
            "C:\\x.png",
            "//host/x.png",
        ] {
            assert!(doc.image(source).is_none(), "{source}");
        }
    }
    #[test]
    fn oversized_files_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("huge.md");
        File::create(&p).unwrap().set_len(LIMIT + 1).unwrap();
        assert!(Document::read(&p).unwrap_err().contains("20 MB"));
    }
}
