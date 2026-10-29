use crate::document::{Document, Result};
use serde::Serialize;
use std::path::PathBuf;

pub fn heading_filename(heading: Option<&str>, current: Option<&std::path::Path>) -> Option<String> {
    let extension = current.and_then(|p| p.extension()).and_then(|v| v.to_str()).unwrap_or("md");
    if ["mmd", "mermaid"].iter().any(|v| extension.eq_ignore_ascii_case(v)) {
        return None;
    }
    let cleaned: String = heading?.chars()
        .filter(|c| !c.is_control() && !"<>:\"/\\|?*".contains(*c))
        .collect();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let stem: String = cleaned.trim_matches([' ', '.']).chars().take(100).collect();
    let stem = stem.trim_end_matches([' ', '.']);
    if stem.is_empty() { return None; }
    let base = stem.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"].contains(&base.as_str());
    Some(format!("{}{stem}.{extension}", if reserved { "_" } else { "" }))
}

pub enum Choice {
    Save,
    Discard,
    Cancel,
}
pub trait Dialogs {
    fn open(&self) -> Option<PathBuf>;
    fn save(&self, current: Option<&std::path::Path>) -> Option<PathBuf>;
    fn unsaved(&self) -> Choice;
    fn overwrite(&self) -> bool;
}
#[derive(Default)]
pub struct Session {
    pub doc: Document,
    pub startup: Option<PathBuf>,
}
#[derive(Serialize, Debug)]
pub struct Response {
    pub kind: &'static str,
    pub text: Option<String>,
    pub mermaid: bool,
}
impl Response {
    fn new(kind: &'static str, text: Option<String>) -> Self {
        Self {
            kind,
            text,
            mermaid: false,
        }
    }
}

impl Session {
    fn save(&mut self, text: &str, as_new: bool, ui: &impl Dialogs) -> Result<bool> {
        let path = if as_new || self.doc.path.is_none() {
            ui.save(self.doc.path.as_deref())
        } else {
            self.doc.path.clone()
        };
        let Some(path) = path else { return Ok(false) };
        let same = self
            .doc
            .path
            .as_ref()
            .is_some_and(|p| std::fs::canonicalize(&path).unwrap_or(path.clone()) == *p);
        if same && self.doc.changed_on_disk()? && !ui.overwrite() {
            return Ok(false);
        }
        self.doc.write(&path, text)?;
        Ok(true)
    }
    pub fn perform(
        &mut self,
        action: &str,
        text: &str,
        dirty: bool,
        ui: &impl Dialogs,
    ) -> Result<Response> {
        if action == "save" || action == "saveAs" {
            return Ok(if self.save(text, action == "saveAs", ui)? {
                Response::new("saved", Some(text.into()))
            } else {
                Response::new("none", None)
            });
        }
        if !["new", "open", "close", "startup"].contains(&action) {
            return Err("Unknown file action".into());
        }
        let path = match action {
            "open" => match ui.open() {
                Some(p) => Some(p),
                None => return Ok(Response::new("none", None)),
            },
            "startup" => match self.startup.take() {
                Some(p) => Some(p),
                None => return Ok(Response::new("none", None)),
            },
            _ => None,
        };
        if dirty {
            match ui.unsaved() {
                Choice::Cancel => return Ok(Response::new("none", None)),
                Choice::Save => {
                    if !self.save(text, false, ui)? {
                        return Ok(Response::new("none", None));
                    }
                }
                Choice::Discard => {}
            }
        }
        if action == "close" {
            return Ok(Response::new("close", None));
        }
        if let Some(path) = path {
            // Read after Save, so reopening the same file cannot reload stale content.
            let (doc, text) = Document::read(&path)?;
            self.doc = doc;
            Ok(Response::new("load", Some(text)))
        } else {
            self.doc = Document::default();
            Ok(Response::new("load", Some(String::new())))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn heading_names_are_safe_and_preserve_document_type() {
        use std::path::Path;
        assert_eq!(heading_filename(Some(" My first note "), None).as_deref(), Some("My first note.md"));
        assert_eq!(heading_filename(Some("Café 日本語"), None).as_deref(), Some("Café 日本語.md"));
        assert_eq!(heading_filename(Some("Plan: Q4 / draft?*"), None).as_deref(), Some("Plan Q4 draft.md"));
        assert_eq!(heading_filename(Some("CON"), None).as_deref(), Some("_CON.md"));
        assert_eq!(heading_filename(Some("CON.notes"), None).as_deref(), Some("_CON.notes.md"));
        assert_eq!(heading_filename(Some(" .. "), None), None);
        assert_eq!(heading_filename(None, None), None);
        assert_eq!(heading_filename(Some("Notes"), Some(Path::new("old.markdown"))).as_deref(), Some("Notes.markdown"));
        assert_eq!(heading_filename(Some("Notes"), Some(Path::new("old.mmd"))), None);
        assert_eq!(heading_filename(Some(&"界".repeat(200)), None).unwrap().chars().count(), 103);
    }
    struct Ui {
        path: Option<PathBuf>,
        choice: u8,
        overwrite: bool,
    }
    impl Dialogs for Ui {
        fn open(&self) -> Option<PathBuf> {
            self.path.clone()
        }
        fn save(&self, _: Option<&std::path::Path>) -> Option<PathBuf> {
            self.path.clone()
        }
        fn unsaved(&self) -> Choice {
            match self.choice {
                0 => Choice::Save,
                1 => Choice::Discard,
                _ => Choice::Cancel,
            }
        }
        fn overwrite(&self) -> bool {
            self.overwrite
        }
    }
    #[test]
    fn cancelled_close_or_save_keeps_document() {
        let mut s = Session::default();
        let ui = Ui {
            path: None,
            choice: 2,
            overwrite: false,
        };
        assert_eq!(s.perform("close", "draft", true, &ui).unwrap().kind, "none");
        let ui = Ui { choice: 0, ..ui };
        assert_eq!(s.perform("new", "draft", true, &ui).unwrap().kind, "none");
    }
    #[test]
    fn discard_and_clean_close() {
        let mut s = Session::default();
        let ui = Ui {
            path: None,
            choice: 1,
            overwrite: false,
        };
        assert_eq!(s.perform("new", "draft", true, &ui).unwrap().kind, "load");
        assert_eq!(s.perform("close", "", false, &ui).unwrap().kind, "close");
    }
    #[test]
    fn reopen_after_save_reads_latest_text() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("notes.md");
        let ui = Ui {
            path: Some(p.clone()),
            choice: 0,
            overwrite: true,
        };
        let mut s = Session::default();
        s.perform("save", "old", true, &ui).unwrap();
        assert_eq!(
            s.perform("open", "new", true, &ui).unwrap().text.unwrap(),
            "new"
        );
    }
    #[test]
    fn external_change_requires_overwrite() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("notes.md");
        let ui = Ui {
            path: Some(p.clone()),
            choice: 0,
            overwrite: false,
        };
        let mut s = Session::default();
        s.perform("save", "original", true, &ui).unwrap();
        std::fs::write(&p, "external").unwrap();
        assert_eq!(s.perform("save", "local", true, &ui).unwrap().kind, "none");
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "external");
        let ui = Ui {
            overwrite: true,
            ..ui
        };
        assert_eq!(s.perform("save", "local", true, &ui).unwrap().kind, "saved");
    }
    #[test]
    fn failed_open_retains_previous_document() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("notes.md");
        let ui = Ui {
            path: Some(p.clone()),
            choice: 1,
            overwrite: false,
        };
        let mut s = Session::default();
        s.perform("save", "original", true, &ui).unwrap();
        let original = s.doc.path.clone();
        let ui = Ui {
            path: Some(d.path().join("missing")),
            ..ui
        };
        assert!(s.perform("open", "draft", true, &ui).is_err());
        assert_eq!(s.doc.path, original);
    }
}
