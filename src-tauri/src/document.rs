use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
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

#[derive(Default)]
struct ImageCopies {
    files: Vec<PathBuf>,
    directories: Vec<PathBuf>,
    committed: bool,
}
impl Drop for ImageCopies {
    fn drop(&mut self) {
        if self.committed { return; }
        for path in self.files.iter().rev() { let _ = fs::remove_file(path); }
        for path in self.directories.iter().rev() { let _ = fs::remove_dir(path); }
    }
}
impl ImageCopies {
    fn directory(&mut self, base: &Path, relative: &Path) -> Result<PathBuf> {
        let mut directory = base.to_path_buf();
        for part in relative.components() {
            let Component::Normal(name) = part else { return Err("Invalid image folder.".into()); };
            directory.push(name);
            match fs::create_dir(&directory) {
                Ok(()) => self.directories.push(directory.clone()),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {},
                Err(e) => return Err(e.to_string()),
            }
            let resolved = fs::canonicalize(&directory).map_err(|e| e.to_string())?;
            if !resolved.starts_with(base) || !resolved.is_dir() {
                return Err("The destination image folder must stay inside the document folder.".into());
            }
        }
        Ok(directory)
    }
}

fn image_reference(source: &str) -> Option<(PathBuf, &'static str)> {
    if source.len() > 4096 { return None; }
    let decoded = percent_encoding::percent_decode_str(source).decode_utf8().ok()?;
    if decoded.contains(':') || decoded.starts_with(['/', '\\']) { return None; }
    let mut relative = PathBuf::new();
    for part in Path::new(decoded.as_ref()).components() {
        match part {
            Component::Normal(name) => relative.push(name),
            Component::CurDir => {},
            Component::ParentDir => { if !relative.pop() { return None; } },
            _ => return None,
        }
    }
    let mime = image_mime(&relative)?;
    Some((relative, mime))
}
fn image_mime(path: &Path) -> Option<&'static str> {
    Some(match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "gif" => "image/gif",
        "webp" => "image/webp", "bmp" => "image/bmp", _ => return None,
    })
}

impl Document {
    pub fn write_with_images(&mut self, path: &Path, text: &str, sources: &[String]) -> Result<()> {
        let Some(old_parent) = self.path.as_ref().and_then(|p| p.parent()) else {
            return self.write(path, text);
        };
        let old_base = fs::canonicalize(old_parent).map_err(|e| e.to_string())?;
        let new_base = fs::canonicalize(path.parent().unwrap_or(Path::new("."))).map_err(|e| e.to_string())?;
        if old_base == new_base || sources.is_empty() { return self.write(path, text); }
        let mut copied = ImageCopies::default();
        for source in sources {
            let Some((relative, _)) = image_reference(source) else { continue; };
            // Preserve existing unavailable-image placeholders without broadening local file access.
            let original = fs::canonicalize(old_base.join(&relative)).ok()
                .filter(|p| p.starts_with(&old_base) && image_mime(p).is_some());
            let Some(original) = original else {
                if fs::symlink_metadata(new_base.join(&relative)).is_ok() {
                    return Err(format!("Image {source} is unavailable in the original folder but exists in the destination. Choose another folder for Save As."));
                }
                continue;
            };
            let bytes = read_bytes(&original).map_err(|e| format!("Could not copy image {source}: {e}"))?;
            let parent = copied.directory(&new_base, relative.parent().unwrap_or(Path::new("")))?;
            let destination = parent.join(relative.file_name().ok_or("Invalid image filename.")?);
            if fs::canonicalize(&parent).map_err(|e| e.to_string())? == new_base
                && relative.file_name().unwrap().to_string_lossy().eq_ignore_ascii_case(&path.file_name().ok_or("Invalid document filename.")?.to_string_lossy()) {
                return Err("The document filename conflicts with an image. Choose another filename.".into());
            }
            if fs::symlink_metadata(&destination).is_ok() {
                let resolved = fs::canonicalize(&destination).map_err(|e| e.to_string())?;
                if !resolved.starts_with(&new_base) {
                    return Err("The destination image must stay inside the document folder.".into());
                }
                if read_bytes(&destination)? != bytes {
                    return Err(format!("An image named {} already exists with different contents. Choose another folder for Save As.", relative.display()));
                }
                continue;
            }
            let mut image = tempfile::NamedTempFile::new_in(&parent).map_err(|e| e.to_string())?;
            image.write_all(&bytes).map_err(|e| e.to_string())?;
            image.as_file().sync_all().map_err(|e| e.to_string())?;
            image.persist_noclobber(&destination).map_err(|e| e.error.to_string())?;
            copied.files.push(destination);
        }
        self.write(path, text)?;
        copied.committed = true;
        Ok(())
    }
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
        let (relative, _) = image_reference(source)?;
        let base = fs::canonicalize(self.path.as_ref()?.parent()?).ok()?;
        let file = fs::canonicalize(base.join(relative)).ok()?;
        if !file.starts_with(&base) {
            return None;
        }
        let mime = image_mime(&file)?;
        Some(format!(
            "data:{mime};base64,{}",
            STANDARD.encode(read_bytes(&file).ok()?)
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn image_fixture() -> (tempfile::TempDir, Document, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("original");
        let destination = dir.path().join("destination");
        fs::create_dir_all(original.join("assets/nested")).unwrap();
        fs::create_dir(&destination).unwrap();
        fs::write(original.join("assets/nested/a b.png"), b"image bytes").unwrap();
        fs::write(original.join("assets/unused.png"), b"unrelated").unwrap();
        let mut doc = Document::default();
        doc.bom = true;
        doc.write(&original.join("source.md"), "original\r\n").unwrap();
        (dir, doc, original, destination)
    }
    #[test]
    fn save_as_copies_only_referenced_images_and_preserves_text_and_original() {
        let (_dir, mut doc, original, destination) = image_fixture();
        let text = "# Café\r\n\r\n![Photo](assets/nested/a%20b.png)\r\n";
        let sources = vec!["assets/nested/a%20b.png".into(), "assets/nested/a%20b.png".into()];
        doc.write_with_images(&destination.join("copy.md"), text, &sources).unwrap();
        assert_eq!(fs::read(destination.join("assets/nested/a b.png")).unwrap(), b"image bytes");
        assert!(!destination.join("assets/unused.png").exists());
        assert_eq!(fs::read(original.join("source.md")).unwrap(), b"\xef\xbb\xbforiginal\r\n");
        assert_eq!(Document::read(&destination.join("copy.md")).unwrap().1, text);
        assert!(doc.image(&sources[0]).is_some());
        assert!(!doc.changed_on_disk().unwrap());
        assert_eq!(fs::read(original.join("assets/nested/a b.png")).unwrap(), b"image bytes");
    }
    #[test]
    fn conflicting_image_aborts_without_replacing_documents_or_leaving_copies() {
        let (_dir, mut doc, original, destination) = image_fixture();
        fs::create_dir_all(destination.join("assets/nested")).unwrap();
        fs::write(destination.join("assets/nested/a b.png"), b"existing other image").unwrap();
        fs::write(original.join("assets/first.png"), b"first").unwrap();
        fs::write(destination.join("copy.md"), "keep this document").unwrap();
        let before = doc.path.clone();
        let sources = vec!["assets/first.png".into(), "assets/nested/a%20b.png".into()];
        assert!(doc.write_with_images(&destination.join("copy.md"), "draft", &sources).unwrap_err().contains("different contents"));
        assert_eq!(doc.path, before);
        assert_eq!(fs::read_to_string(destination.join("copy.md")).unwrap(), "keep this document");
        assert_eq!(fs::read(destination.join("assets/nested/a b.png")).unwrap(), b"existing other image");
        assert!(!destination.join("assets/first.png").exists());
        assert!(!doc.changed_on_disk().unwrap());
    }
    #[test]
    fn identical_images_are_reused_and_failed_markdown_write_rolls_back_new_images() {
        let (_dir, mut doc, _original, destination) = image_fixture();
        let sources = vec!["assets/nested/a%20b.png".into()];
        let folder = destination.join("folder.md"); fs::create_dir(&folder).unwrap();
        let before = doc.path.clone();
        assert!(doc.write_with_images(&folder, "draft", &sources).is_err());
        assert_eq!(doc.path, before);
        assert!(!destination.join("assets").exists());
        fs::create_dir_all(destination.join("assets/nested")).unwrap();
        fs::write(destination.join("assets/nested/a b.png"), b"image bytes").unwrap();
        doc.write_with_images(&destination.join("copy.md"), "draft", &sources).unwrap();
        assert_eq!(fs::read_dir(destination.join("assets/nested")).unwrap().count(), 1);
    }
    #[test]
    fn relocation_keeps_image_limits_and_does_not_copy_remote_or_outside_files() {
        let (dir, mut doc, original, destination) = image_fixture();
        fs::write(dir.path().join("secret.png"), b"outside").unwrap();
        let sources = vec!["../secret.png".into(), "%2e%2e/secret.png".into(), "https://example.com/a.png".into(), "data:image/png;base64,eA==".into(), "missing.png".into(), "file.svg".into()];
        doc.write_with_images(&destination.join("copy.md"), "draft", &sources).unwrap();
        assert_eq!(fs::read_dir(&destination).unwrap().count(), 1);
        let (mut doc, _) = Document::read(&original.join("source.md")).unwrap();
        File::create(original.join("huge.png")).unwrap().set_len(LIMIT + 1).unwrap();
        assert!(doc.write_with_images(&destination.join("copy.md"), "replacement", &["huge.png".into()]).is_err());
        assert_eq!(Document::read(&destination.join("copy.md")).unwrap().1, "draft");
    }
    #[test]
    fn markdown_filename_cannot_replace_a_copied_image_even_with_different_case() {
        let (_dir, mut doc, original, destination) = image_fixture();
        fs::write(original.join("photo.png"), b"image").unwrap();
        assert!(doc.write_with_images(&destination.join("PHOTO.PNG"), "draft", &["photo.png".into()]).is_err());
        assert!(!destination.join("photo.png").exists());
    }
    #[test]
    fn missing_original_image_cannot_silently_use_an_unrelated_destination_image() {
        let (_dir, mut doc, _original, destination) = image_fixture();
        fs::write(destination.join("missing.png"), b"unrelated image").unwrap();
        let before = doc.path.clone();
        assert!(doc.write_with_images(&destination.join("copy.md"), "draft", &["missing.png".into()]).is_err());
        assert_eq!(doc.path, before);
        assert!(!destination.join("copy.md").exists());
        assert_eq!(fs::read(destination.join("missing.png")).unwrap(), b"unrelated image");
    }
    #[cfg(windows)]
    #[test]
    fn junctions_cannot_redirect_image_copy_outside_destination() {
        let (dir, mut doc, _original, destination) = image_fixture();
        let outside = dir.path().join("outside"); fs::create_dir(&outside).unwrap();
        let junction = destination.join("assets");
        assert!(std::process::Command::new("cmd.exe").args(["/C", "mklink", "/J"])
            .arg(&junction).arg(&outside).stdout(std::process::Stdio::null()).status().unwrap().success());
        assert!(doc.write_with_images(&destination.join("copy.md"), "draft", &["assets/nested/a%20b.png".into()]).is_err());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
        assert!(!destination.join("copy.md").exists());
    }
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
