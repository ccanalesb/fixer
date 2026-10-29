use std::path::{Component, Path, PathBuf};

/// True when `candidate` equals `root` or lies strictly under it.
pub fn is_path_within_root(root: &Path, candidate: &Path) -> bool {
    let root = root.components().collect::<Vec<_>>();
    let candidate = candidate.components().collect::<Vec<_>>();
    if candidate.len() < root.len() {
        return false;
    }
    for (a, b) in root.iter().zip(candidate.iter()) {
        if a != b {
            return false;
        }
    }
    true
}

/// Refuses deletion targets that were not pre-approved for this wipe.
pub fn may_remove_dir(planned_roots: &[PathBuf], target: &Path) -> bool {
    if matches!(target.components().next(), Some(Component::Prefix(_)) | None) {
        return false;
    }
    planned_roots
        .iter()
        .any(|root| root == target || is_path_within_root(root, target))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn refuses_paths_outside_planned_roots() {
        let tmp = tempdir().unwrap();
        let allowed = tmp.path().join("com.ccanales.fixer");
        fs::create_dir_all(&allowed).unwrap();
        let outside = tmp.path().join("other-app");
        fs::create_dir_all(&outside).unwrap();

        let planned = vec![allowed.clone()];
        assert!(may_remove_dir(&planned, &allowed));
        assert!(!may_remove_dir(&planned, &outside));
        assert!(!may_remove_dir(&planned, Path::new("/etc/passwd")));
    }

    #[test]
    fn allows_a_subdirectory_of_a_planned_root() {
        let tmp = tempdir().unwrap();
        let root = tmp.path().join("com.ccanales.fixer");
        let nested = root.join("caches");
        fs::create_dir_all(&nested).unwrap();

        let planned = vec![root.clone()];
        assert!(may_remove_dir(&planned, &nested));
    }
}
