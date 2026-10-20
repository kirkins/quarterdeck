#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod appearance;
mod connection;
mod font;
mod icon;
mod notification;
mod screen;
mod widget;
mod window;

use data::config::{self, Config};
use data::dashboard::View;
use data::environment;
use iced::widget::{column, container};
use iced::{Length, Subscription, Task};

use self::appearance::{Theme, theme};
use self::connection::Connection;
use self::screen::{dashboard, feed, settings};
use self::widget::{Element, text};

pub fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args()
        .skip(1)
        .any(|arg| arg == "--version" || arg == "-V")
    {
        println!("{} {}", environment::APP_SLUG, environment::VERSION);
        return Ok(());
    }

    setup_logging();
    log::info!(
        "{} {} has started",
        environment::APP_SLUG,
        environment::VERSION
    );
    log::info!("config dir: {}", environment::config_dir().display());
    log::info!("data dir: {}", environment::data_dir().display());

    // Load the saved state before iced starts its own runtime.
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let (config_load, window_load, dashboard_load) = rt.block_on(async {
        tokio::join!(
            Config::load(),
            data::Window::load(),
            data::Dashboard::load()
        )
    });
    rt.shutdown_background();

    if let Err(error) = &config_load {
        log::error!("config: {error}");
    }

    // The font must be set from the config before iced uses it.
    font::set(config_load.as_ref().ok());

    let default_text_size = config_load
        .as_ref()
        .ok()
        .and_then(|config| config.font.size)
        .map_or(theme::TEXT_SIZE, f32::from);

    iced::daemon(
        move || {
            Quarterdeck::new(
                config_load.clone(),
                window_load.clone(),
                dashboard_load.clone(),
            )
        },
        Quarterdeck::update,
        Quarterdeck::view,
    )
    .title(Quarterdeck::title)
    .theme(Quarterdeck::theme)
    .scale_factor(Quarterdeck::scale_factor)
    .subscription(Quarterdeck::subscription)
    .settings(iced::Settings {
        default_font: font::MONO.clone().into(),
        default_text_size: default_text_size.into(),
        id: None,
        antialiasing: false,
        fonts: font::load(),
        vsync: true,
    })
    .run()
    .inspect_err(|error| log::error!("{error}"))?;

    Ok(())
}

/// Open a web link from a message in the browser. Ships write these links,
/// so only http and https are opened.
fn open_link(url: &str) {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        log::info!("not opening {url}: only web links open from messages");
        return;
    }
    if let Err(error) = open::that_detached(url) {
        log::warn!("could not open {url}: {error}");
    }
}

fn setup_logging() {
    let level = if cfg!(debug_assertions) {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Info
    };

    let _ = fern::Dispatch::new()
        .format(|out, message, record| {
            out.finish(format_args!(
                "{} {:<5} {}",
                record.target(),
                record.level(),
                message
            ));
        })
        .level(log::LevelFilter::Warn)
        .level_for("quarterdeck", level)
        .level_for("data", level)
        .chain(std::io::stderr())
        .apply();
}

struct Quarterdeck {
    config: Config,
    config_error: Option<String>,
    mode: appearance::Mode,
    theme: Theme,
    main_window: window::Window,
    settings_window: Option<window::Id>,
    settings: settings::Settings,
    dashboard: dashboard::Dashboard,
    connection: Connection,
}

#[derive(Debug, Clone)]
enum Message {
    Dashboard(dashboard::Message),
    Settings(settings::Message),
    Window(window::Id, window::Event),
    Maximized(bool),
    /// Read the watched live session again.
    SessionTick,
    /// Read the fleet again, if it is due.
    FleetTick,
    /// A file dropped onto a window.
    FileDropped(iced::window::Id, std::path::PathBuf),
    /// Read what the captain answered lately, if it is due.
    AnsweredTick,
    /// Redraw, to turn the loading spinners.
    Animate,
    /// Read the Spend pane's usage again.
    SpendTick,
    /// Read the open items again, while the Feed is shown.
    FeedTick,
    AppearanceChanged(appearance::Mode),
    ConfigReloaded(Result<Config, config::Error>),
    Saved(Result<(), String>),
    Connection(connection::Message),
    Written(
        String,
        Result<data::privateer::Sent, data::privateer::Error>,
    ),
}

impl Quarterdeck {
    fn new(
        config_load: Result<Config, config::Error>,
        window_load: Result<data::Window, window::Error>,
        dashboard_load: data::Dashboard,
    ) -> (Self, Task<Message>) {
        let data::Window {
            size,
            position,
            fullscreen,
            maximized,
        } = window_load.unwrap_or_default();

        let (main_window, open_main_window) = window::open(window::Settings {
            size: fullscreen.unwrap_or(size),
            position: position
                .map(window::Position::Specific)
                .unwrap_or_default(),
            min_size: Some(window::MIN_SIZE),
            exit_on_close_request: false,
            fullscreen: fullscreen.is_some(),
            ..window::settings()
        });

        let (config, config_error) = match config_load {
            Ok(config) => (config, None),
            Err(error) => (Config::default(), Some(error.to_string())),
        };

        // Mundy sends the system's light or dark preference on startup.
        let mode = appearance::Mode::Unspecified;
        let theme = mode.theme(&config.appearance.selected).into();

        let mut window = window::Window::new(main_window);
        window.fullscreen = fullscreen;
        window.maximized = maximized;
        window.windowed_position = position;
        window.windowed_size = size;

        let open = if maximized {
            open_main_window.then(move |_| window::maximize(main_window, true))
        } else {
            open_main_window.discard()
        };

        let mut connection = Connection::new(&config.privateer);
        connection.notify =
            config.notifications.enabled(config.privateer.source);
        connection.feed.open_only = dashboard_load.feed_only_waiting;
        let first_poll = connection.poll();
        let settings = settings::Settings::new(&config.privateer);

        let mut quarterdeck = Quarterdeck {
            config,
            config_error,
            mode,
            theme,
            main_window: window,
            settings_window: None,
            settings,
            dashboard: dashboard::Dashboard::new(&dashboard_load),
            connection,
        };
        let spend = quarterdeck.read_spend(false);

        (
            quarterdeck,
            Task::batch([open, first_poll.map(Message::Connection), spend]),
        )
    }

    fn title(&self, id: window::Id) -> String {
        if Some(id) == self.settings_window {
            format!("{} settings", environment::APP_NAME)
        } else {
            environment::APP_NAME.to_string()
        }
    }

    fn theme(&self, _window: window::Id) -> Theme {
        self.theme.clone()
    }

    fn scale_factor(&self, _window: window::Id) -> f32 {
        self.config.scale_factor.into()
    }

    fn update(&mut self, message: Message) -> Task<Message> {
        // A pane may have come on screen, the usage asked for changed, or
        // the connection is new: the Spend pane reads what it lacks.
        let spend_may_change = matches!(
            message,
            Message::Dashboard(_) | Message::ConfigReloaded(Ok(_))
        );
        // The Feed pane may have come on screen: its open items are read.
        let feed_may_appear = matches!(message, Message::Dashboard(_))
            && !self.dashboard.shows(View::Feed);
        let applied = self.apply(message);
        self.dashboard.feed_seen(&self.connection);
        let mut tasks = vec![applied];
        if spend_may_change {
            tasks.push(self.read_spend(false));
            tasks.push(self.read_tools(false));
        }
        if feed_may_appear {
            tasks.push(self.read_open_feed());
        }
        Task::batch(tasks)
    }

    /// Read what the Spend pane shows, while it is on screen: the routes
    /// once, the usage when its query changes or `refresh` asks.
    fn read_spend(&mut self, refresh: bool) -> Task<Message> {
        if !self.dashboard.shows(View::Spend) {
            return Task::none();
        }
        self.connection
            .read_spend(self.dashboard.spend_query(), refresh)
            .map(Message::Connection)
    }

    /// Read the open ship's tools while they are on screen: once per ship,
    /// and again on `refresh` when the read failed.
    fn read_tools(&mut self, refresh: bool) -> Task<Message> {
        let Some(ship) = self.dashboard.tools_ship() else {
            return Task::none();
        };
        self.connection
            .read_profile(ship, refresh)
            .map(Message::Connection)
    }

    fn apply(&mut self, message: Message) -> Task<Message> {
        match message {
            Message::SpendTick => self.read_spend(true),
            Message::FeedTick => self.read_open_feed(),
            Message::Dashboard(message) => match self
                .dashboard
                .update(message, &self.connection)
            {
                Some(dashboard::Event::Write { key, command, args }) => {
                    Task::perform(
                        self.connection.send(command, args),
                        move |result| Message::Written(key.clone(), result),
                    )
                }
                Some(dashboard::Event::LayoutChanged) => self.save_layout(),
                Some(dashboard::Event::Copy(text)) => {
                    iced::clipboard::write(text)
                }
                Some(dashboard::Event::PickFiles(which)) => {
                    Task::perform(pick_files(), move |paths| {
                        Message::Dashboard(dashboard::Dashboard::attach(
                            which, paths,
                        ))
                    })
                }
                Some(dashboard::Event::ReadFleet) => {
                    self.connection.read_fleet().map(Message::Connection)
                }
                Some(dashboard::Event::OpenSettings) => self.open_settings(),
                Some(dashboard::Event::OpenLink(url)) => {
                    open_link(&url);
                    Task::none()
                }
                Some(dashboard::Event::WatchSession(target)) => self
                    .connection
                    .read_session(&target)
                    .map(Message::Connection),
                Some(dashboard::Event::ReadReport(id)) => {
                    self.connection.read_report(id).map(Message::Connection)
                }
                Some(dashboard::Event::LoadOlder(which)) => self
                    .connection
                    .update(connection::Message::LoadOlder(which))
                    .map(Message::Connection),
                Some(dashboard::Event::OpenShip(scope)) => {
                    self.connection.open_ship(scope).map(Message::Connection)
                }
                Some(dashboard::Event::FeedOnlyWaiting(on)) => {
                    let read = self
                        .connection
                        .set_open_only(on)
                        .map(Message::Connection);
                    Task::batch([read, self.save_layout()])
                }
                Some(dashboard::Event::FeedScope(scope)) => self
                    .connection
                    .set_scope(Some(scope))
                    .map(Message::Connection),
                Some(dashboard::Event::FeedToNewest) => feed::to_newest(),
                Some(dashboard::Event::Refresh) => Task::batch([
                    self.connection.poll().map(Message::Connection),
                    self.connection.read_ships(true).map(Message::Connection),
                    self.read_tools(true),
                ]),
                Some(dashboard::Event::RefreshShips) => {
                    self.connection.read_ships(true).map(Message::Connection)
                }
                None => Task::none(),
            },
            Message::Settings(message) => match self.settings.update(message) {
                Some(settings::Action::Reload) => {
                    Task::perform(Config::load(), Message::ConfigReloaded)
                }
                Some(settings::Action::Edit(edit)) => Task::perform(
                    async move {
                        Config::apply(edit).await?;
                        Config::load().await
                    },
                    Message::ConfigReloaded,
                ),
                Some(settings::Action::Test(revision, config)) => {
                    Task::perform(
                        settings::test_connection(config),
                        move |result| {
                            Message::Settings(settings::Message::Tested(
                                revision, result,
                            ))
                        },
                    )
                }
                None => Task::none(),
            },
            Message::ConfigReloaded(Ok(config)) => {
                self.config = config;
                self.config_error = None;
                self.settings.loaded(&self.config.privateer);
                self.theme =
                    self.mode.theme(&self.config.appearance.selected).into();
                let poll = self.connection.configure(&self.config.privateer);
                self.connection.notify = self
                    .config
                    .notifications
                    .enabled(self.config.privateer.source);
                poll.map(Message::Connection)
            }
            Message::Written(key, result) => {
                let sent = matches!(result, Ok(data::privateer::Sent::Sent(_)));
                self.dashboard.written(key, result);
                // A sent answer closes the ask: read the list again, and
                // what was answered.
                if sent {
                    self.connection.answered_changed();
                    self.connection.poll().map(Message::Connection)
                } else {
                    Task::none()
                }
            }
            Message::Connection(message) => {
                self.connection.update(message).map(Message::Connection)
            }
            Message::ConfigReloaded(Err(error)) => {
                log::error!("config: {error}");
                self.config_error = Some(error.to_string());
                self.settings.failed(error.to_string());
                Task::none()
            }
            Message::AppearanceChanged(mode) => {
                self.mode = mode;
                self.theme =
                    mode.theme(&self.config.appearance.selected).into();
                Task::none()
            }
            Message::Saved(Err(error)) => {
                log::warn!("could not save: {error}");
                Task::none()
            }
            Message::Saved(Ok(())) => Task::none(),
            Message::Window(id, event) => self.window_event(id, event),
            Message::SessionTick => match self.dashboard.watching() {
                Some(target) => {
                    let target = target.clone();
                    self.connection
                        .read_session(&target)
                        .map(Message::Connection)
                }
                None => Task::none(),
            },
            Message::Animate => Task::none(),
            Message::AnsweredTick => {
                if self.dashboard.shows(View::Triage) {
                    self.connection.read_answered().map(Message::Connection)
                } else {
                    Task::none()
                }
            }
            // A file dropped onto the window goes to the composer in view.
            // Wayland windows get no drops from winit yet; Attach works there.
            Message::FileDropped(id, path) => {
                match self.dashboard.drop_target() {
                    Some(which) if id == self.main_window.id => {
                        self.apply(Message::Dashboard(
                            dashboard::Dashboard::attach(which, vec![path]),
                        ))
                    }
                    _ => Task::none(),
                }
            }
            Message::FleetTick => {
                if self.fleet_shown() {
                    self.connection.read_fleet().map(Message::Connection)
                } else {
                    Task::none()
                }
            }
            Message::Maximized(maximized) => {
                self.main_window.update_maximize(maximized);
                Task::none()
            }
        }
    }

    fn window_event(
        &mut self,
        id: window::Id,
        event: window::Event,
    ) -> Task<Message> {
        if Some(id) == self.settings_window {
            if let window::Event::CloseRequested = event {
                self.settings_window = None;
                return window::close(id);
            }
            return Task::none();
        }
        if id != self.main_window.id {
            return Task::none();
        }

        match event {
            window::Event::Opened { position, size } => {
                self.main_window.opened(position, size);
                Task::none()
            }
            window::Event::Moved(position) => {
                self.main_window.position = Some(position);
                Task::none()
            }
            window::Event::Resized(size) => {
                self.main_window.size = size;
                window::is_maximized(id).map(Message::Maximized)
            }
            window::Event::Focused => {
                self.main_window.focused = true;
                // Coming back is when a late copy is worth reading.
                self.read_open_feed()
            }
            window::Event::Unfocused => {
                self.main_window.focused = false;
                Task::none()
            }
            window::Event::CloseRequested => {
                // Save where things were, then quit.
                let window = data::Window::from(self.main_window);
                let layout = self.saved_layout();
                Task::future(async move {
                    if let Err(error) = window.save().await {
                        log::warn!("could not save the window: {error}");
                    }
                    if let Err(error) = layout.save().await {
                        log::warn!("could not save the layout: {error}");
                    }
                })
                .discard()
                .chain(iced::exit())
            }
        }
    }

    /// The Fleet pane, Live or Ships with their lists, or Spend's live route
    /// state, is on screen.
    fn fleet_shown(&self) -> bool {
        [View::Fleet, View::Live, View::Ships, View::Spend]
            .into_iter()
            .any(|view| self.dashboard.shows(view))
    }

    fn save_layout(&self) -> Task<Message> {
        Task::perform(self.saved_layout().save(), Message::Saved)
    }

    /// The layout to save, with the Feed's choice of open items.
    fn saved_layout(&self) -> data::Dashboard {
        data::Dashboard {
            feed_only_waiting: self.connection.feed.open_only,
            ..self.dashboard.saved()
        }
    }

    /// Read the open items again, when the Feed is on screen.
    fn read_open_feed(&mut self) -> Task<Message> {
        if !self.dashboard.shows(View::Feed) {
            return Task::none();
        }
        self.connection.read_open().map(Message::Connection)
    }

    fn open_settings(&mut self) -> Task<Message> {
        if let Some(id) = self.settings_window {
            return window::gain_focus(id);
        }
        let (id, open) = window::open(window::Settings {
            size: iced::Size::new(560.0, 520.0),
            min_size: Some(window::MIN_SIZE),
            exit_on_close_request: false,
            ..window::settings()
        });
        self.settings_window = Some(id);
        open.discard()
    }

    fn view(&self, id: window::Id) -> Element<'_, Message> {
        if Some(id) == self.settings_window {
            return settings::view(&self.config, &self.settings)
                .map(Message::Settings);
        }

        let dashboard = self
            .dashboard
            .view(&self.config, &self.connection, &self.theme)
            .map(Message::Dashboard);

        let content: Element<'_, Message> = match &self.config_error {
            Some(error) => column![
                container(
                    text(format!(
                        "Could not load or save config: {error}. \
                         The last loaded settings remain in use."
                    ))
                    .style(theme::text::error),
                )
                .padding([6, 12]),
                dashboard,
            ]
            .into(),
            None => dashboard,
        };

        container(content)
            .width(Length::Fill)
            .height(Length::Fill)
            .style(theme::container::root)
            .into()
    }

    fn subscription(&self) -> Subscription<Message> {
        Subscription::batch([
            window::events().map(|(id, event)| Message::Window(id, event)),
            iced::event::listen_with(|event, _, id| match event {
                iced::Event::Window(iced::window::Event::FileDropped(path)) => {
                    Some(Message::FileDropped(id, path))
                }
                _ => None,
            }),
            appearance::subscription().map(Message::AppearanceChanged),
            iced::time::every(self.connection.poll_every())
                .map(|_| Message::Connection(connection::Message::Poll)),
            // A watched live session is read every second, only while shown.
            if self.dashboard.watching().is_some() {
                iced::time::every(std::time::Duration::from_secs(1))
                    .map(|_| Message::SessionTick)
            } else {
                Subscription::none()
            },
            // Spinners turn only while something is loading.
            if self.connection.busy() {
                iced::time::every(std::time::Duration::from_millis(100))
                    .map(|_| Message::Animate)
            } else {
                Subscription::none()
            },
            // The fleet is read every 15 s while its pane, Live's list of
            // sessions or Spend's routes are on screen; the tick also keeps
            // its times fresh.
            if self.fleet_shown() {
                iced::time::every(std::time::Duration::from_secs(1))
                    .map(|_| Message::FleetTick)
            } else {
                Subscription::none()
            },
            // What the captain answered lately is read while Triage is
            // shown: the tick is cheap, a read happens only when due.
            if self.dashboard.shows(View::Triage) {
                iced::time::every(std::time::Duration::from_secs(1))
                    .map(|_| Message::AnsweredTick)
            } else {
                Subscription::none()
            },
            // The open items are read again while the Feed is shown, so a
            // late desk copy appears.
            if self.dashboard.shows(View::Feed) {
                iced::time::every(connection::OPEN_EVERY)
                    .map(|_| Message::FeedTick)
            } else {
                Subscription::none()
            },
            // The Spend pane's usage is read again every minute it is shown.
            if self.dashboard.shows(View::Spend) {
                iced::time::every(std::time::Duration::from_secs(60))
                    .map(|_| Message::SpendTick)
            } else {
                Subscription::none()
            },
        ])
    }
}

/// The files the captain picks, through the desktop's file chooser; none
/// when the chooser is closed.
async fn pick_files() -> Vec<std::path::PathBuf> {
    rfd::AsyncFileDialog::new()
        .set_title("Attach files")
        .pick_files()
        .await
        .map(|files| files.iter().map(|f| f.path().to_owned()).collect())
        .unwrap_or_default()
}
