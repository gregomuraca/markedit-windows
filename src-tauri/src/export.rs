use std::{fs, io::{Read, Write}, path::{Path, PathBuf}, sync::mpsc, time::Duration};
use tauri::WebviewWindow;

pub const LIMIT: usize = 64 * 1024 * 1024;

pub fn suggested_name(heading: Option<&str>, source: Option<&Path>, format: &str) -> String {
    let name = crate::session::heading_filename(heading, None)
        .map(PathBuf::from)
        .or_else(|| source.and_then(|p| p.file_name()).map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("Untitled.md"));
    name.with_extension(format).to_string_lossy().into_owned()
}

pub fn validate_path(path: &Path, source: Option<&Path>, format: &str) -> Result<(), String> {
    if !["html", "pdf"].contains(&format) { return Err("Choose HTML or PDF export.".into()); }
    if !path.extension().and_then(|s| s.to_str()).is_some_and(|s| s.eq_ignore_ascii_case(format)) {
        return Err(format!("Choose a .{format} filename for this export."));
    }
    if let Some(source) = source {
        if fs::canonicalize(path).ok().as_ref() == fs::canonicalize(source).ok().as_ref()
            && fs::canonicalize(source).is_ok() {
            return Err("Export cannot replace the open Markdown file. Choose another filename.".into());
        }
    }
    Ok(())
}

pub fn write_html(path: &Path, html: &str) -> Result<(), String> {
    if html.len() > LIMIT { return Err("The exported document exceeds the 64 MB export limit.".into()); }
    let parent = path.parent().ok_or("Choose an export folder.")?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    file.write_all(html.as_bytes()).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.error.to_string())?;
    Ok(())
}

pub async fn write_pdf(window: WebviewWindow, path: PathBuf) -> Result<(), String> {
    let parent = path.parent().ok_or("Choose an export folder.")?;
    let temporary = tempfile::Builder::new().prefix(".markedit-export-").suffix(".pdf")
        .tempfile_in(parent).map_err(|e| e.to_string())?.into_temp_path();
    let output = temporary.to_path_buf();
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    window.with_webview(move |webview| {
        use webview2_com::{Microsoft::Web::WebView2::Win32::{ICoreWebView2_7, ICoreWebView2Environment6}, PrintToPdfCompletedHandler};
        use windows::core::{HSTRING, Interface};
        let failure = tx.clone();
        let setup = || -> windows::core::Result<()> {
            unsafe {
                let view = webview.controller().CoreWebView2()?.cast::<ICoreWebView2_7>()?;
                let settings = webview.environment().cast::<ICoreWebView2Environment6>()?.CreatePrintSettings()?;
                settings.SetShouldPrintBackgrounds(true)?;
                settings.SetShouldPrintHeaderAndFooter(false)?;
                settings.SetPageWidth(8.2677)?;
                settings.SetPageHeight(11.6929)?;
                settings.SetMarginTop(0.6)?;
                settings.SetMarginBottom(0.6)?;
                settings.SetMarginLeft(0.6)?;
                settings.SetMarginRight(0.6)?;
                let callback = PrintToPdfCompletedHandler::create(Box::new(move |result, success| {
                    let value = result.map_err(|e| e.to_string()).and_then(|_| {
                        if success { Ok(()) } else { Err("WebView2 could not create the PDF. Try again or update WebView2.".into()) }
                    });
                    let _ = tx.send(value);
                    Ok(())
                }));
                view.PrintToPdf(&HSTRING::from(output.to_string_lossy().as_ref()), &settings, &callback)?;
            }
            Ok(())
        };
        if let Err(error) = setup() { let _ = failure.send(Err(error.to_string())); }
    }).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(90)).map_err(|_| "PDF export timed out. Try a smaller document.".to_string())??;
        let mut signature = [0; 5];
        fs::File::open(&temporary).and_then(|mut file| file.read_exact(&mut signature)).map_err(|e| e.to_string())?;
        if &signature != b"%PDF-" { return Err("The PDF could not be verified. The destination was not replaced.".into()); }
        temporary.persist(path).map_err(|e| e.error.to_string())?;
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn names_use_heading_or_document_stem_and_expected_extension() {
        assert_eq!(suggested_name(Some("Title: Q4?"), None, "pdf"), "Title Q4.pdf");
        assert_eq!(suggested_name(None, Some(Path::new("notes.md")), "html"), "notes.html");
        assert_eq!(suggested_name(None, None, "html"), "Untitled.html");
    }
    #[test]
    fn export_never_replaces_source_and_failed_output_preserves_existing_files() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("notes.md"); fs::write(&source, "draft").unwrap();
        assert!(validate_path(&source, Some(&source), "html").is_err());
        let html = dir.path().join("notes.html");
        assert!(validate_path(&html, Some(&source), "html").is_ok());
        write_html(&html, "<!doctype html><p>one</p>").unwrap();
        write_html(&html, "<!doctype html><p>two</p>").unwrap();
        assert_eq!(fs::read_to_string(&source).unwrap(), "draft");
        assert!(fs::read_to_string(&html).unwrap().contains("two"));
        let folder = dir.path().join("folder.html"); fs::create_dir(&folder).unwrap();
        assert!(write_html(&folder, "new").is_err());
        assert!(folder.is_dir());
        assert!(!fs::read_dir(dir.path()).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with(".tmp")));
    }
}
