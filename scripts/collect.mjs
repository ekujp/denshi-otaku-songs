name: collect-candidates
on:
  schedule:
    - cron: "0 18 * * *"   # 毎日 日本時間の午前3時
  workflow_dispatch:        # 手動実行ボタン
jobs:
  collect:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install --no-save @supabase/supabase-js@2
      - run: node scripts/collect.mjs
        env:
          LASTFM_API_KEY: ${{ secrets.LASTFM_API_KEY }}
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}
