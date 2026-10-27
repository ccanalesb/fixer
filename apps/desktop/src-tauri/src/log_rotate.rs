use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

const MAX_BYTES: u64 = 10 * 1024 * 1024;
const MAX_FILES: u32 = 5;

/// Append-only log writer with size-based rotation (`name`, `name.1`, … `name.4`).
pub struct RotatingLog {
    dir: PathBuf,
    name: String,
    file: File,
    size: u64,
}

impl RotatingLog {
    pub fn open(dir: impl AsRef<Path>, name: &str) -> io::Result<Self> {
        fs::create_dir_all(&dir)?;
        let dir = dir.as_ref().to_path_buf();
        let path = dir.join(name);
        let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        Ok(Self {
            dir,
            name: name.to_string(),
            file,
            size,
        })
    }

    pub fn write_line(&mut self, line: &[u8]) -> io::Result<()> {
        let n = (line.len() + 1) as u64;
        if self.size + n > MAX_BYTES {
            self.rotate()?;
        }
        self.file.write_all(line)?;
        self.file.write_all(b"\n")?;
        self.size += n;
        Ok(())
    }

    fn rotate(&mut self) -> io::Result<()> {
        drop(std::mem::replace(
            &mut self.file,
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.dir.join(&self.name))?,
        ));

        let oldest = self.dir.join(format!("{}.{}", self.name, MAX_FILES - 1));
        let _ = fs::remove_file(&oldest);

        for i in (1..MAX_FILES - 1).rev() {
            let from = self.dir.join(format!("{}.{}", self.name, i));
            let to = self.dir.join(format!("{}.{}", self.name, i + 1));
            if from.exists() {
                fs::rename(from, to)?;
            }
        }

        let first = self.dir.join(format!("{}.1", self.name));
        let base = self.dir.join(&self.name);
        if base.exists() {
            fs::rename(&base, first)?;
        }

        self.file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&base)?;
        self.size = 0;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn rotates_when_over_limit() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = RotatingLog::open(dir.path(), "backend.log").unwrap();
        let chunk = vec![b'x'; (MAX_BYTES / 2) as usize + 1];
        log.write_line(&chunk).unwrap();
        log.write_line(&chunk).unwrap();

        assert!(dir.path().join("backend.log.1").exists());
        let mut contents = String::new();
        File::open(dir.path().join("backend.log.1"))
            .unwrap()
            .read_to_string(&mut contents)
            .unwrap();
        assert!(contents.starts_with('x'));
    }

    #[test]
    fn drops_oldest_after_max_files() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = RotatingLog::open(dir.path(), "backend.log").unwrap();
        let chunk = vec![b'a'; (MAX_BYTES / 2) as usize + 1];
        for _ in 0..12 {
            log.write_line(&chunk).unwrap();
        }
        assert!(!dir.path().join("backend.log.5").exists());
        assert!(dir.path().join("backend.log.4").exists());
    }
}
