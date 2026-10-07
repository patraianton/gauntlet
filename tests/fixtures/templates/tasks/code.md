Add a command `export --csv <file>` to the CLI that writes all saved listings to a CSV file.
Columns: id, title, price, currency, url, saved_at. Prices with two decimals, UTF-8 with a header row.
It must work on Windows and macOS and must not change the existing commands.
Add tests for the new command and update the README.
Source: example task for the lens library, 2026-10-06.
