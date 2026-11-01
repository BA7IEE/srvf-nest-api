"""Read host/cgroup memory without treating an absent root limit as unlimited."""
import re
from pathlib import Path


def memory_admission(cgroup=Path('/sys/fs/cgroup'), meminfo=Path('/proc/meminfo')):
    text = meminfo.read_text()

    def kib(name):
        match = re.search(r'^' + name + r':\s+([0-9]+)\s+kB\s*$', text, re.M)
        if not match or int(match.group(1)) <= 0:
            raise ValueError('INVALID_HOST_MEMORY_' + name)
        return int(match.group(1)) * 1024

    total = kib('MemTotal')
    available = kib('MemAvailable')
    if available > total:
        raise ValueError('INVALID_HOST_MEMORY_AVAILABLE')
    limit_file = cgroup / 'memory.max'
    configured = limit_file.read_text().strip() if limit_file.exists() else 'max'
    if configured == 'max':
        return {'source': 'host-root', 'memoryLimitBytes': total,
                'memoryUsedBytes': total - available, 'memoryAvailableBytes': available}
    current = (cgroup / 'memory.current').read_text().strip()
    if not re.fullmatch(r'[0-9]+', configured) or not re.fullmatch(r'[0-9]+', current):
        raise ValueError('INVALID_CGROUP_MEMORY')
    limit, used = int(configured), int(current)
    if limit <= 0 or used > limit:
        raise ValueError('INVALID_CGROUP_MEMORY_RANGE')
    return {'source': 'cgroup', 'memoryLimitBytes': limit, 'memoryUsedBytes': used,
            'memoryAvailableBytes': min(available, limit - used)}
