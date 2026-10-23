"""Create a consistent SQLite backup without stopping JournAi."""
import datetime
import os
import pathlib
import sqlite3

os.umask(0o077)
root = pathlib.Path('/var/lib/journai')
backup_dir = root / 'backups'
backup_dir.mkdir(mode=0o700, exist_ok=True)
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
with sqlite3.connect(f'file:{root / "journai.db"}?mode=ro', uri=True) as source:
    with sqlite3.connect(backup_dir / f'journai-{stamp}.db') as target:
        source.backup(target)
        result = target.execute('PRAGMA integrity_check').fetchone()[0]
        if result != 'ok':
            raise RuntimeError('Backup integrity check failed')
