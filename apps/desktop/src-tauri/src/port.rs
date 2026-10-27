pub const DEFAULT_PORT: u16 = 5101;

pub fn app_port() -> u16 {
    std::env::var("LT_APP_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .filter(|p| *p > 0)
        .unwrap_or(DEFAULT_PORT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_when_unset() {
        std::env::remove_var("LT_APP_PORT");
        assert_eq!(app_port(), DEFAULT_PORT);
    }
}
