# Event presets

A preset is a published programme — a conference, a festival, a school
swimming carnival — expressed as data, so the app and the big-screen display
can both read it without either one knowing the event's name.

Before this folder existed, the South Australia ADHD Conference lived as a
hardcoded `AGENDA` object at the top of `app/app.js`, wrapped in a comment
listing the seven places you had to delete from to remove it. That comment was
the warning. Adding a second conference that way would have doubled it.

## Adding a conference

1. Write `<id>.json` in this folder, following the shape below.
2. Add a row to `index.json`.
3. Bump `CACHE` in `app/sw.js` — installed copies keep serving the old files
   otherwise, which for a programme means serving yesterday's times.

That is the whole job. No JavaScript changes. `app/program.js` and the preset
loader in `app/app.js` read whatever `index.json` lists.

## The shape

```json
{
  "id": "nwc26",                       // must match the filename
  "schemaVersion": 1,
  "revision": "2026-09-22",            // when this file was last checked
                                       // against the organiser's programme
  "name": "Neurodivergence Wellbeing Conference 2026",
  "shortName": "NWC26",                // fits a phone header; keep it short
  "venue": "RACV Royal Pines Resort, Gold Coast",
  "timeZone": "Australia/Brisbane",    // for humans
  "utcOffsetMinutes": 600,             // for arithmetic — see below
  "official": false,                   // true only if the organiser
                                       // published this file themselves
  "source": { "label": "anzmh.asn.au/nwc", "url": "https://anzmh.asn.au/nwc" },
  "disclaimer": "Unofficial. Times are approximate...",
  "days": [ ... ]
}
```

### `utcOffsetMinutes`, and why a fixed number is allowed here

Minutes **east** of UTC. Brisbane is `600`, Adelaide `570`, Sydney in
daylight saving `660`.

A fixed offset is normally the wrong way to store a time zone, because
daylight saving moves it. It is safe in these two presets for two separate
reasons, and a third preset needs its own reason checked:

- **NWC26** is in Queensland, which has no daylight saving at all.
- **SA ADHD 2026** was on 19 September; South Australian daylight saving
  started on 4 October that year, so the whole event sat on one offset.

If an event **straddles** a daylight-saving boundary, this field cannot
express it, and the preset must be split into two — or the loader taught
about `timeZone` properly. Nothing in the code will warn you.

The offset exists so an organiser previewing the programme from Adelaide sees
it running on the venue's clock rather than their own. A delegate standing in
the venue is already on the venue's clock and would get the same answer
either way.

### `days[]`

```json
{
  "date": "2026-09-28",     // ISO, the venue's own calendar date
  "label": "Day one",       // shown beside the weekday
  "start": 510,             // minutes past midnight — the day's first pie
  "lunch": 750,             // the midday pie, or null for none
  "end": 1020,              // the last pie
  "items": [ ... ]
}
```

`start`, `lunch` and `end` are the three pies the main app already draws.
They are what `?preset=<id>` writes over the person's own weekday hours **for
that date only** — their ordinary working week is never touched.

### `items[]`

```json
{ "n": 4, "time": 750, "kind": "meal", "title": "Lunch" }
```

- **`n`** — position within the day, from 1. It is part of the appointment id
  (`<preset id>-<date>-<n>`, zero-padded), which is what stops the same
  session being added twice when someone opens the link again. **Never
  renumber `n` to fix an ordering mistake** on a programme people are already
  holding: change `time` and leave `n` alone, or the old copy stays beside the
  new one.
- **`time`** — minutes past midnight. Venue wall clock.
- **`kind`** — `keynote` · `session` · `workshop` · `break` · `meal` ·
  `social` · `close`. Colour on the display and nothing else. An unknown kind
  falls back to `session`.
- **`title`** — 80 characters, because that is where the app truncates.

### End times, which this format mostly infers

**The app's own appointment model has no end time.** An appointment is
`{ id, title, date, time }` — a moment to count down to, not a block. So a
preset infers a session's finish from the start of the next item in the same
day, which is how a printed programme reads anyway.

Three optional fields cover what inference cannot reach:

- **`"end": 1140`** — an explicit finish. Needed for the only item of a day,
  or for any item followed by a real gap rather than the next session.
- **`"open": true`** — published start, no published finish. The display reads
  "5:00 pm onwards" and draws no pie, rather than inventing a duration.
- **`"moment": true`** — a point, not a block: a close, a welcome, a cut of a
  ribbon. No pie, no duration.

If an item is last in its day and carries none of the three, the day's `end`
is used when it is later than the item's `time`; failing that the item is
treated as `open`. The display never guesses a length.
