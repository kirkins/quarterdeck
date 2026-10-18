#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod appearance;
mod connection;
mod font;
mod icon;
mod screen;
mod widget;
mod window;

use data::config::{self, Config};
use data::environment;
use iced::widget::{column, container};
use iced::{Length, Subscription, Task};

use self::appearance::{Theme, theme};
use self::connection::Connection;
use self::screen::{dashboard, settings};
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
    dashboard: dashboard::Dashboard,
    connection: Connection,
}

#[derive(Debug, Clone)]
enum Message {
    Dashboard(dashboard::Message),
    Settings(settings::Message),
    Window(window::Id, window::Event),
    Maximized(bool),
    AppearanceChanged(appearance::Mode),
    ConfigReloaded(Result<Config, config::Error>),
    Saved(Result<(), String>),
    Connection(connection::Message),
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
        let first_poll = connection.poll();

        (
            Quarterdeck {
                config,
                config_error,
                mode,
                theme,
                main_window: window,
                settings_window: None,
                dashboard: dashboard::Dashboard::new(&dashboard_load),
                connection,
            },
            Task::batch([open, first_poll.map(Message::Connection)]),
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
        match message {
            Message::Dashboard(message) => match self.dashboard.update(message)
            {
                Some(dashboard::Event::LayoutChanged) => self.save_layout(),
                Some(dashboard::Event::OpenSettings) => self.open_settings(),
                Some(dashboard::Event::OpenLink(url)) => {
                    open_link(&url);
                    Task::none()
                }
                Some(dashboard::Event::Refresh) => {
                    self.connection.poll().map(Message::Connection)
                }
                None => Task::none(),
            },
            Message::Settings(settings::Message::Reload) => {
                Task::perform(Config::load(), Message::ConfigReloaded)
            }
            Message::Settings(settings::Message::Edit(edit)) => Task::perform(
                async move {
                    Config::apply(edit).await?;
                    Config::load().await
                },
                Message::ConfigReloaded,
            ),
            Message::ConfigReloaded(Ok(config)) => {
                self.config = config;
                self.config_error = None;
                self.theme =
                    self.mode.theme(&self.config.appearance.selected).into();
                self.connection
                    .configure(&self.config.privateer)
                    .map(Message::Connection)
            }
            Message::Connection(message) => {
                self.connection.update(message).map(Message::Connection)
            }
            Message::ConfigReloaded(Err(error)) => {
                log::error!("config: {error}");
                self.config_error = Some(error.to_string());
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
                Task::none()
            }
            window::Event::Unfocused => {
                self.main_window.focused = false;
                Task::none()
            }
            window::Event::CloseRequested => {
                // Save where things were, then quit.
                let window = data::Window::from(self.main_window);
                let layout = self.dashboard.saved();
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

    fn save_layout(&self) -> Task<Message> {
        Task::perform(self.dashboard.saved().save(), Message::Saved)
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
            return settings::view(&self.config).map(Message::Settings);
        }

        let dashboard = self
            .dashboard
            .view(&self.config, &self.connection, &self.theme)
            .map(Message::Dashboard);

        let content: Element<'_, Message> = match &self.config_error {
            Some(error) => column![
                container(
                    text(format!(
                        "Your config could not be read, so the defaults are in \
                         use: {error}"
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
            appearance::subscription().map(Message::AppearanceChanged),
            iced::time::every(self.connection.poll_every())
                .map(|_| Message::Connection(connection::Message::Poll)),
        ])
    }
}
