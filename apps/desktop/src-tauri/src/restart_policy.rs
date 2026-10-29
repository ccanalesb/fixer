use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidecarDeathAction {
    RestartOnce,
    ShowError,
}

#[derive(Debug, Default)]
pub struct RestartPolicy {
    recent_deaths: Vec<Instant>,
}

impl RestartPolicy {
    const WINDOW: Duration = Duration::from_secs(60);

    pub fn record_death(&mut self, now: Instant) -> SidecarDeathAction {
        self.recent_deaths
            .retain(|t| now.duration_since(*t) < Self::WINDOW);
        if self.recent_deaths.is_empty() {
            self.recent_deaths.push(now);
            SidecarDeathAction::RestartOnce
        } else {
            self.recent_deaths.push(now);
            SidecarDeathAction::ShowError
        }
    }

    pub fn reset(&mut self) {
        self.recent_deaths.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_death_restarts_once() {
        let mut policy = RestartPolicy::default();
        let t0 = Instant::now();
        assert_eq!(
            policy.record_death(t0),
            SidecarDeathAction::RestartOnce
        );
    }

    #[test]
    fn second_death_within_window_shows_error() {
        let mut policy = RestartPolicy::default();
        let t0 = Instant::now();
        assert_eq!(
            policy.record_death(t0),
            SidecarDeathAction::RestartOnce
        );
        assert_eq!(
            policy.record_death(t0 + Duration::from_secs(5)),
            SidecarDeathAction::ShowError
        );
    }

    #[test]
    fn death_after_window_allows_restart_again() {
        let mut policy = RestartPolicy::default();
        let t0 = Instant::now();
        let _ = policy.record_death(t0);
        assert_eq!(
            policy.record_death(t0 + Duration::from_secs(61)),
            SidecarDeathAction::RestartOnce
        );
    }

    #[test]
    fn reset_clears_history() {
        let mut policy = RestartPolicy::default();
        let t0 = Instant::now();
        let _ = policy.record_death(t0);
        policy.reset();
        assert_eq!(
            policy.record_death(t0 + Duration::from_secs(1)),
            SidecarDeathAction::RestartOnce
        );
    }
}
