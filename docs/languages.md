# Languages

Residents can switch between **English and Español** on the join, booking, appointment and lobby display pages, using the menu in the header. Each language is listed in its own language, so people can find theirs.

- **The choice is remembered** on the device. The first visit follows the phone's language settings.
- **The resident's language follows their ticket.** It's stored on the ticket or appointment (`lang`) when they join or book, and updated if they switch later (`PUT /api/o/:id/tickets/:ticketId/language`, `PUT …/appointments/:id/language`). A ticket created at appointment check-in inherits the appointment's language.
  - **Push and email alerts** are written in that language, including times and dates (`miércoles, 4 de marzo · 12:00 p. m.`).
  - **The lobby speaks each call in the called resident's language,** with a matching voice if the device has one ("Número D, 0, 1, 9, pase a Counter 1."), whatever language the TV screen itself shows.
- **Staff pages stay in English.** Service and counter names are shown as staff typed them.
- **Adding a language** (e.g. Vietnamese):
  1. Copy `web/src/i18n/es.ts` to `vi.ts` and translate it. TypeScript fails the build if any phrase is missing.
  2. Add a row to `LANGUAGES` in `web/src/i18n/index.tsx`.
  3. Add `'vi'` to `Lang` in `web/src/types.ts`.
  4. Add the code and its alert texts in `server/src/i18n.ts`.
