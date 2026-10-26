# Accessibility

Checked against WCAG 2.2 AA with automated tests (see [testing.md](testing.md#accessibility)).

- **Screen readers:**
  - Every control has a label, and each page has one `h1`.
  - `<html lang>` matches the page's language.
  - The service, day and time choices are real radio groups.
  - The QR code is described.
  - Error messages are tied to the field they're about.
- **Live announcements:**
  - "You're now number 2 in line. 1 person ahead of you." is read out when the resident moves up.
  - "It's your turn. Please go to Counter 3." is read out at once when they're called, and focus moves to it.
  - The lobby display and staff actions announce through status regions too.
- **Keyboard:**
  - A "Skip to main content" link comes first on every page.
  - Everything works with Tab, Enter and Space, and arrow keys move through choices.
  - Escape closes the leave and cancel questions and the staff priority menu, returning focus to the button that opened them.
  - Following a link moves focus to the new page's heading.
  - Staff single-key shortcuts (N, S, X, R) can be switched off on the console, because they clash with screen reader keys.
- **Visible focus:** a thick ring on every control, white on dark and colored backgrounds.
- **Larger text:** the **AA** button in the header scales the page's text by 25% and is remembered on the device. The layout reflows, with the header controls wrapping onto their own row. The lobby display is already sized for viewing across a room, so it doesn't change.
- **Reduced motion:** when the device asks for less motion, fades, pulses and spinners are turned off.
