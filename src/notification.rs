//! Showing an alert as a desktop notification.

use data::alert::Alert;
use data::environment;

/// Show it on a thread of its own: the desktop's notification service can be
/// slow or missing, and the window never waits on it.
pub fn show(alert: Alert) {
    std::thread::spawn(move || {
        let shown = notify_rust::Notification::new()
            .appname(environment::APP_NAME)
            .summary(&alert.title)
            .body(&alert.body)
            .show();
        if let Err(error) = shown {
            log::warn!("could not show a notification: {error}");
        }
    });
}
