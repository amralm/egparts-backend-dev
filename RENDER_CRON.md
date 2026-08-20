# Payment proof retention cron

Create a separate Render **Cron Job** from the `backend` directory:

- Build command: `npm ci`
- Command: `npm run retention:cleanup`
- Schedule: `*/15 * * * *`
- Environment: copy the backend Web Service variables, including the Supabase service-role key and all R2 variables.

The Web Service timer is only a best-effort fallback. The Cron Job is the
production scheduler because the Render Web Service may sleep.

Verify the first run contains a JSON line like:

```json
{"ok":true,"converted":0,"deleted":0,"failed":0}
```

Do not expose the cron command as a public HTTP endpoint and do not put R2 or
Supabase secrets in the repository.
