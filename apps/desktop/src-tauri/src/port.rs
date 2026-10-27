use std::io::{self, Write};
use std::net::TcpListener;
use std::path::Path;

pub const DEFAULT_PORT: u16 = 5101;
pub const PORT_FILE_NAME: &str = "port";

pub fn port_from_env() -> Option<u16> {
    std::env::var("LT_APP_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .filter(|p| *p > 0)
}

pub fn read_port_file(data_dir: &Path) -> Option<u16> {
    let raw = std::fs::read_to_string(data_dir.join(PORT_FILE_NAME)).ok()?;
    parse_port_text(&raw)
}

pub fn write_port_file(data_dir: &Path, port: u16) -> io::Result<()> {
    if port == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "port must be greater than zero",
        ));
    }
    std::fs::create_dir_all(data_dir)?;
    let path = data_dir.join(PORT_FILE_NAME);
    let mut file = std::fs::File::create(path)?;
    file.write_all(format!("{port}\n").as_bytes())?;
    Ok(())
}

pub fn resolve_port(data_dir: &Path) -> u16 {
    port_from_env()
        .or_else(|| read_port_file(data_dir))
        .unwrap_or(DEFAULT_PORT)
}

pub fn is_loopback_port_in_use(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_err()
}

fn parse_port_text(raw: &str) -> Option<u16> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let port: u16 = trimmed.parse().ok()?;
    (port > 0).then_some(port)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use tempfile::TempDir;

    #[test]
    fn default_when_unset() {
        env::remove_var("LT_APP_PORT");
        let dir = TempDir::new().unwrap();
        assert_eq!(resolve_port(dir.path()), DEFAULT_PORT);
    }

    #[test]
    fn env_overrides_file_and_default() {
        let dir = TempDir::new().unwrap();
        write_port_file(dir.path(), 5107).unwrap();
        env::set_var("LT_APP_PORT", "5200");
        assert_eq!(resolve_port(dir.path()), 5200);
        env::remove_var("LT_APP_PORT");
    }

    #[test]
    fn file_persists_round_trip() {
        env::remove_var("LT_APP_PORT");
        let dir = TempDir::new().unwrap();
        write_port_file(dir.path(), 5107).unwrap();
        assert_eq!(read_port_file(dir.path()), Some(5107));
        assert_eq!(resolve_port(dir.path()), 5107);
    }

    #[test]
    fn invalid_file_ignored() {
        env::remove_var("LT_APP_PORT");
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join(PORT_FILE_NAME), "nope\n").unwrap();
        assert_eq!(resolve_port(dir.path()), DEFAULT_PORT);
    }
}
