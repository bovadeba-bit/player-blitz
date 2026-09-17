プレイヤー persistent data lives here.

For an upgrade from your working Phase 4.4 folder, copy your existing:
  data/player.sqlite
  data/player.sqlite-wal   (only while the old server is fully stopped, if it exists)
  data/player.sqlite-shm   (only while the old server is fully stopped, if it exists)

Safest method: fully stop the old プレイヤー server first, then copy the entire old data folder into this Phase 5 folder.
Do not overwrite your newer live database with an older backup.
