mod app;
mod tea;

use app::App;

fn main() -> std::io::Result<()> {
    let mut terminal = ratatui::init();
    let result = tea::run::<App>(&mut terminal);
    ratatui::restore();
    result
}
