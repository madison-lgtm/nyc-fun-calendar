# NYC Fun Calendar

A static, shareable NYC events calendar with scheduled event-data refresh.

## Deploy

For one-time sharing, you can still upload this folder to any static host. For automatic refresh, use GitHub + Netlify.

## Automatic Refresh Setup

1. Create a new GitHub repository.
2. Upload the contents of this folder to the repository root.
3. In GitHub, open the Actions tab and enable workflows if prompted.
4. Go to Netlify and create a new site from that GitHub repository.
5. Set the publish directory to the repository root.
6. Leave the build command blank.

The GitHub Action in `.github/workflows/update-events.yml` runs twice per day and commits an updated `events.json`. Netlify redeploys when that commit lands, so the public link stays the same.

The app stores selected plans in the URL, for example:

`?plan=dance,wmi_percussion`

Views are also shareable:

- `?view=today`
- `?view=week`
- `?view=month`

## Data

The current first pass uses curated Bryant Park listings, latest non-sponsored The Skint digest posts from The Skint's public WordPress API, and nearby source cards for NYC Parks, Jersey City Cultural Affairs, and Visit Hudson.

Month view is a compact agenda grouped by date. Week and Today use the time-grid calendar view.

## Refresh Frequency

The app loads listings from `events.json` and checks for a fresh copy every 30 minutes while someone has the page open.

That means:

- If `events.json` is updated on the server, visitors will see the new data automatically.
- The GitHub Action updates `events.json` twice per day.
- Netlify redeploys automatically after each update commit.
- Netlify Drop uploads are still manual and do not run GitHub Actions.

Default schedule:

- Refresh every morning around 7 AM for normal daily planning.
- Refresh again around 3-4 PM for after-work changes and newly posted listings.

The app keeps a visible "last updated" timestamp and every card keeps its original source link.
