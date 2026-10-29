#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod document;
mod session;
mod export;

use session::{Choice, Dialogs, Session};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{
    menu::{MenuBuilder, SubmenuBuilder},
    Emitter, Manager, WebviewWindow,
};

type Shared = Arc<Mutex<Session>>;
struct NativeDialogs(WebviewWindow, Option<String>);
impl Dialogs for NativeDialogs {
    fn open(&self) -> Option<PathBuf> {
        rfd::FileDialog::new()
            .set_parent(&self.0)
            .add_filter(
                "Markdown, Mermaid and text",
                &["md", "markdown", "mmd", "mermaid", "txt"],
            )
            .add_filter("All files", &["*"])
            .pick_file()
    }
    fn save(&self, current: Option<&Path>) -> Option<PathBuf> {
        let mut dialog = rfd::FileDialog::new().set_parent(&self.0);
        let mermaid = current
            .and_then(|p| p.extension())
            .and_then(|s| s.to_str())
            .is_some_and(|ext| {
                ext.eq_ignore_ascii_case("mmd") || ext.eq_ignore_ascii_case("mermaid")
            });
        if mermaid {
            dialog = dialog
                .add_filter("Mermaid", &["mmd", "mermaid"])
                .add_filter("Markdown", &["md"]);
        } else {
            dialog = dialog
                .add_filter("Markdown", &["md"])
                .add_filter("Mermaid", &["mmd", "mermaid"]);
        }
        dialog = dialog.add_filter("All files", &["*"]);
        if let Some(path) = current {
            if let Some(parent) = path.parent() {
                dialog = dialog.set_directory(parent);
            }
            if let Some(name) = path.file_name() {
                dialog = dialog.set_file_name(name.to_string_lossy());
            }
        } else {
            dialog = dialog.set_file_name("Untitled.md");
        }
        if let Some(name) = session::heading_filename(self.1.as_deref(), current) {
            dialog = dialog.set_file_name(name);
        }
        dialog.save_file()
    }
    fn unsaved(&self) -> Choice {
        match rfd::MessageDialog::new()
            .set_parent(&self.0)
            .set_title("Unsaved changes")
            .set_description("Save your changes before continuing?")
            .set_buttons(rfd::MessageButtons::YesNoCancelCustom(
                "Save".into(),
                "Don't save".into(),
                "Cancel".into(),
            ))
            .show()
        {
            rfd::MessageDialogResult::Custom(label) if label == "Save" => Choice::Save,
            rfd::MessageDialogResult::Custom(label) if label == "Don't save" => Choice::Discard,
            rfd::MessageDialogResult::Yes => Choice::Save,
            rfd::MessageDialogResult::No => Choice::Discard,
            _ => Choice::Cancel,
        }
    }
    fn overwrite(&self) -> bool {
        rfd::MessageDialog::new().set_parent(&self.0).set_title("File changed outside MarkEdit")
            .set_description("The file has changed or was deleted since you opened it. Replace it with your current text?")
            .set_buttons(rfd::MessageButtons::OkCancel).show() == rfd::MessageDialogResult::Ok
    }
}
fn title(window: &WebviewWindow, session: &Session, dirty: bool) {
    let name = session
        .doc
        .path
        .as_ref()
        .and_then(|p| p.file_name())
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Untitled".into());
    let _ = window.set_title(&format!(
        "{}{} — MarkEdit",
        if dirty { "● " } else { "" },
        name
    ));
}
#[tauri::command]
async fn perform(
    window: WebviewWindow,
    state: tauri::State<'_, Shared>,
    action: String,
    text: String,
    dirty: bool,
    heading: Option<String>,
) -> Result<session::Response, String> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut session = shared.lock().map_err(|e| e.to_string())?;
        let mut result = session.perform(&action, &text, dirty, &NativeDialogs(window.clone(), heading))?;
        result.mermaid = session.doc.is_mermaid();
        title(
            &window,
            &session,
            if result.kind == "none" { dirty } else { false },
        );
        if result.kind == "close" {
            window.destroy().map_err(|e| e.to_string())?;
        }
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn changed(window: WebviewWindow, state: tauri::State<'_, Shared>, dirty: bool) {
    if let Ok(session) = state.try_lock() {
        title(&window, &session, dirty);
    }
}
#[tauri::command]
async fn image(state: tauri::State<'_, Shared>, source: String) -> Result<Option<String>, String> {
    let doc = state.lock().map_err(|e| e.to_string())?.doc.clone();
    tauri::async_runtime::spawn_blocking(move || doc.image(&source))
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
async fn attach_image(
    window: WebviewWindow,
    state: tauri::State<'_, Shared>,
    name: String,
    bytes: Vec<u8>,
    text: String,
    dirty: bool,
    heading: Option<String>,
) -> Result<serde_json::Value, String> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut session = shared.lock().map_err(|e| e.to_string())?;
        let mut saved = false;
        if session.doc.path.is_none() {
            let response = session.perform("save", &text, dirty, &NativeDialogs(window.clone(), heading))?;
            if response.kind != "saved" {
                return Ok(serde_json::json!({"source": null, "saved": false}));
            }
            saved = true;
            title(&window, &session, false);
        }
        let source = session.doc.attach_image(&name, &bytes)?;
        Ok(serde_json::json!({"source": source, "saved": saved}))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn open_link(href: String) -> Result<(), String> {
    let url = url::Url::parse(&href).map_err(|e| e.to_string())?;
    if !["http", "https", "mailto"].contains(&url.scheme()) {
        return Err("Only web and email links can be opened.".into());
    }
    open::that(url.as_str()).map_err(|e| e.to_string())
}
#[tauri::command]
async fn export_document(
    window: WebviewWindow,
    state: tauri::State<'_, Shared>,
    format: String,
    html: String,
    heading: Option<String>,
) -> Result<Option<String>, String> {
    if !["html", "pdf"].contains(&format.as_str()) { return Err("Choose HTML or PDF export.".into()); }
    if html.len() > export::LIMIT { return Err("The document exceeds the 64 MB export limit.".into()); }
    let source = state.lock().map_err(|e| e.to_string())?.doc.path.clone();
    let name = export::suggested_name(heading.as_deref(), source.as_deref(), &format);
    let dialog_window = window.clone();
    let dialog_source = source.clone();
    let dialog_format = format.clone();
    let path = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new().set_parent(&dialog_window)
            .set_title(if dialog_format == "html" { "Export HTML" } else { "Export PDF" })
            .add_filter(if dialog_format == "html" { "HTML document" } else { "PDF document" }, &[dialog_format.as_str()])
            .set_file_name(name);
        if let Some(parent) = dialog_source.as_ref().and_then(|p| p.parent()) { dialog = dialog.set_directory(parent); }
        dialog.save_file()
    }).await.map_err(|e| e.to_string())?;
    let Some(path) = path else { return Ok(None); };
    export::validate_path(&path, source.as_deref(), &format)?;
    let display = path.to_string_lossy().into_owned();
    if format == "html" {
        tauri::async_runtime::spawn_blocking(move || export::write_html(&path, &html)).await.map_err(|e| e.to_string())??;
    } else { export::write_pdf(window, path).await?; }
    Ok(Some(display))
}
fn main() {
    let startup = std::env::args_os().nth(1).map(PathBuf::from);
    tauri::Builder::default()
        .manage(Arc::new(Mutex::new(Session {
            startup,
            ..Default::default()
        })))
        .invoke_handler(tauri::generate_handler![perform, changed, image, attach_image, open_link, export_document])
        .setup(|app| {
            let window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Untitled — MarkEdit")
            .disable_drag_drop_handler()
            .inner_size(1200.0, 800.0)
            .min_inner_size(720.0, 480.0)
            .on_navigation(|url| {
                url.scheme() == "tauri"
                    || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
            })
            .build()?;
            let export_menu = SubmenuBuilder::new(app, "Export")
                .text("export:html", "HTML…")
                .text("export:pdf", "PDF…")
                .build()?;
            let file = SubmenuBuilder::new(app, "File")
                .text("new", "New\tCtrl+N")
                .text("open", "Open…\tCtrl+O")
                .separator()
                .text("save", "Save\tCtrl+S")
                .text("saveAs", "Save As…\tCtrl+Shift+S")
                .item(&export_menu)
                .separator()
                .text("close", "Close")
                .build()?;
            let edit = SubmenuBuilder::new(app, "Edit")
                .text("undo", "Undo\tCtrl+Z")
                .text("redo", "Redo\tCtrl+Y")
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .separator()
                .text("find", "Find and replace…\tCtrl+F")
                .build()?;
            let format = SubmenuBuilder::new(app, "Format")
                .text("toggleBold", "Bold\tCtrl+B")
                .text("toggleItalic", "Italic\tCtrl+I")
                .text("toggleStrikethrough", "Strikethrough")
                .text("toggleInlineCode", "Inline code\tCtrl+E")
                .separator()
                .text("toggleBullet", "Bullet list")
                .text("toggleTodo", "Task list")
                .text("toggleBlockquote", "Quote")
                .text("link", "Insert link")
                .text("image", "Insert image…")
                .text("table", "Insert table")
                .build()?;
            let view = SubmenuBuilder::new(app, "View")
                .text("layout:edit", "Write")
                .text("layout:split", "Split")
                .text("layout:read", "Read")
                .separator()
                .text("theme", "Toggle dark theme")
                .build()?;
            app.set_menu(
                MenuBuilder::new(app)
                    .items(&[&file, &edit, &format, &view])
                    .build()?,
            )?;
            app.on_menu_event(|app, event| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("desktop-command", event.id().as_ref());
                }
            });
            let closing = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = closing.emit("desktop-command", "close");
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Could not start MarkEdit");
}
