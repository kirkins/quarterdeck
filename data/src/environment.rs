use std::env;
use std::path::PathBuf;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const CONFIG_FILE_NAME: &str = "config.toml";
pub const APP_NAME: &str = "Quarterdeck";
pub const APP_SLUG: &str = "quarterdeck";
pub const APPLICATION_ID: &str = "org.privateer.quarterdeck";

pub fn config_dir() -> PathBuf {
    portable_dir().unwrap_or_else(platform_specific_config_dir)
}

pub fn data_dir() -> PathBuf {
    portable_dir().unwrap_or_else(|| {
        dirs_next::data_dir()
            .expect("expected valid data dir")
            .join(APP_SLUG)
    })
}

/// A config file beside the executable makes it portable: that directory
/// then holds both config and data.
fn portable_dir() -> Option<PathBuf> {
    let exe = env::current_exe().ok()?;
    let dir = exe.parent()?;

    dir.join(CONFIG_FILE_NAME)
        .is_file()
        .then(|| dir.to_path_buf())
}

fn platform_specific_config_dir() -> PathBuf {
    // On macOS too, prefer ~/.config/quarterdeck when it has a config file.
    #[cfg(target_os = "macos")]
    if let Some(home) = dirs_next::home_dir() {
        let dir = home.join(".config").join(APP_SLUG);
        if dir.join(CONFIG_FILE_NAME).is_file() {
            return dir;
        }
    }

    dirs_next::config_dir()
        .expect("expected valid config dir")
        .join(APP_SLUG)
}
