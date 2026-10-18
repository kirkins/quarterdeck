// A toolkit copied from Halloy: not every widget is used yet.
#![allow(dead_code, unused_imports)]
pub use self::anchored_overlay::anchored_overlay;
pub use self::combo_box::combo_box;
pub use self::context_menu::context_menu;
pub use self::decorate::decorate;
pub use self::double_pass::double_pass;
pub use self::key_press::key_press;
pub use self::markdown::markdown;
pub use self::modal::modal;
pub use self::on_resize::on_resize;
pub use self::tooltip::tooltip;
use crate::{Theme, font};

pub mod anchored_overlay;
pub mod combo_box;
pub mod context_menu;
pub mod decorate;
pub mod double_pass;
pub mod key_press;
pub mod markdown;
pub mod modal;
pub mod on_resize;
pub mod pick_list;
pub mod tooltip;

pub type Renderer = iced::Renderer;
pub type Element<'a, Message> = iced::Element<'a, Message, Theme, Renderer>;
pub type Content<'a, Message> =
    iced::widget::pane_grid::Content<'a, Message, Theme, Renderer>;
pub type TitleBar<'a, Message> =
    iced::widget::pane_grid::TitleBar<'a, Message, Theme, Renderer>;
pub type Column<'a, Message> =
    iced::widget::Column<'a, Message, Theme, Renderer>;
pub type Row<'a, Message> = iced::widget::Row<'a, Message, Theme, Renderer>;
pub type Text<'a> = iced::widget::Text<'a, Theme, Renderer>;
pub type Container<'a, Message> =
    iced::widget::Container<'a, Message, Theme, Renderer>;
pub type Button<'a, Message> = iced::widget::Button<'a, Message, Theme>;

pub fn text<'a>(
    content: impl iced::widget::text::IntoFragment<'a>,
) -> Text<'a> {
    let fragment = content.into_fragment();

    iced::widget::text(fragment.clone())
        .line_height(font::line_height())
        .shaping(font::shaping_for_text(fragment.as_ref()))
}

pub mod button {
    use super::Element;
    use crate::appearance::theme;

    /// Transparent button which simply makes the given content
    /// into a clickable button without additional styling.
    pub fn transparent_button<'a, Message>(
        content: impl Into<Element<'a, Message>>,
        message: Message,
    ) -> Element<'a, Message>
    where
        Message: Clone + 'a,
    {
        iced::widget::button(content)
            .padding(0)
            .style(theme::button::bare)
            .on_press(message)
            .into()
    }
}
