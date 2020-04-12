"""

WARNING!

- This should NOT be used if you're self hosting AT ALL.

"""

from subprocess import Popen, PIPE, STDOUT
import threading
import os
import time
from datetime import datetime


TOTAL_CLUSTERS = 2
SHARDS_PER_CLUSTER = 2
TOTAL_SHARDS = TOTAL_CLUSTERS * SHARDS_PER_CLUSTER
CURRENT_DIR = os.getcwd()


def shard_ids_from_cluster(cluster, per):
    return list(range(per*cluster, per*cluster+per))


def gen_cluster(cluster_id, shards):
    cmd = f"""python "auto-voice-channels.py" {cluster_id} {shards} {TOTAL_SHARDS}"""
    process = Popen(cmd, shell=True, stdout=PIPE, stdin=PIPE, stderr=STDOUT)

    while True:
        data = process.stdout.readline().decode().replace('\n', '')
        if data != '':
            print(f"[{datetime.now().strftime('%D | %H:%M:%S')}][Cluster - {cluster_id}] {data}")
        time.sleep(0.1)


def start(clusters, shards_per_cluster):
    threads = []
    for clu in range(clusters):
        try:
            t = threading.Thread(target=gen_cluster, args=(clu, shards_per_cluster))
            threads.append(t)
            t.setName(name=f"Cluster [{clu}]")
            print(f"Generating {clu} - Shards {shards_per_cluster} | "
                  f"Ids: {shard_ids_from_cluster(clu, shards_per_cluster)}")
        except (threading.ThreadError, RuntimeError) as e:
            print(f"Error starting cluster {clu}, {e}")

    for thread in threads:
        thread.start()
        print(f"Started {thread.name}")


if __name__ == "__main__":
    start(clusters=TOTAL_CLUSTERS, shards_per_cluster=SHARDS_PER_CLUSTER)

