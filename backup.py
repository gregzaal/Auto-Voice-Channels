import cfg
import functions as func
import logging
import os
import shutil
import sys
import time
import traceback
from discord.ext.tasks import loop


def start_backups(client):
    if cfg.SAPPHIRE_ID is not None and cfg.SAPPHIRE_ID != 0:
        logging.info("Skipping backups.")
        return  # Gold bot will take care of sapphire backups.

    try:
        import b2sdk.v1 as b2
        cfg.CONFIG['b2_key_id']
        cfg.CONFIG['b2_key']
        cfg.CONFIG['b2_destination']
    except ImportError:
        logging.warning("Failed to import b2sdk, not running guild backups.")
    except KeyError:
        logging.warning("Backup keys or destination unspecified.")
    else:
        backup_scriptdir.start(client, b2)


@loop(minutes=20)
async def backup_scriptdir(client, b2):
    try:
        print("Backing up scriptdir...")

        info = b2.InMemoryAccountInfo()

        b2_api = b2.B2Api(info)

        application_key_id = cfg.CONFIG['b2_key_id']
        application_key = cfg.CONFIG['b2_key']
        b2_api.authorize_account("production", application_key_id, application_key)

        source = cfg.SCRIPT_DIR
        destination = cfg.CONFIG['b2_destination']

        source_tmp = os.path.join(cfg.SCRIPT_DIR, '.tmp_BU')
        if os.path.exists(source_tmp):
            shutil.rmtree(source_tmp)
        shutil.copytree(source,
                        source_tmp,
                        symlinks=False,
                        ignore=shutil.ignore_patterns(
                            '.*', 'bot-env', '__pycache__'
                        ))

        source = b2.parse_sync_folder(source_tmp, b2_api)
        destination = b2.parse_sync_folder(destination, b2_api)

        policies_manager = b2.ScanPoliciesManager(
            exclude_dir_regexes=("bot-env", ".git", ".*__(.*)__.*", "^\\.(.*)"),
            exclude_file_regexes=("^\\.(.*)", ".*__pycache__.*", ".*\\.txt"),
            exclude_all_symlinks=True
        )

        synchronizer = b2.Synchronizer(
            max_workers=10,
            policies_manager=policies_manager,
            dry_run=False,
            allow_empty_source=True,
            newer_file_mode=b2.NewerFileSyncMode.REPLACE,
            keep_days_or_delete=b2.KeepOrDeleteMode.DELETE,
        )

        no_progress = True
        with b2.SyncReport(sys.stdout, no_progress) as reporter:
            synchronizer.sync_folders(
                source_folder=source,
                dest_folder=destination,
                now_millis=int(round(time.time() * 1000)),
                reporter=reporter,
            )

        print("Backup complete.")
        shutil.rmtree(source_tmp)
    except:
        print(traceback.format_exc())
        if client.is_ready():
            await func.admin_log(traceback.format_exc(), client, important=True)
