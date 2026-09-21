// The executor inherits both the root and exclusive project lock. Parent death cannot release
// exclusion while it is unlinking, and no pathname traversal follows a symbolic link.
export const PURGE_FILESYSTEM = String.raw`import fcntl, json, os, re, stat, sys
data = json.load(sys.stdin)
project = data['projectId']
uuid = r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}'
if not re.fullmatch(uuid, project):
    raise ValueError('Invalid project identity')
prefix = '.project-store/' + project + '/'
roots = data['roots']
if not roots or len(roots) > 100040 or len(set(roots)) != len(roots):
    raise ValueError('Invalid cleanup selection')
for name in roots:
    if not (re.fullmatch(uuid, name) or re.fullmatch(re.escape(prefix) + r'(?:state/retention/content|public/candidates)/' + uuid, name) or re.fullmatch(re.escape(prefix) + r'state/content/objects/[a-f0-9]{64}\.[rx]', name)):
        raise ValueError('Cleanup path is outside the selected content')
def parts(name):
    values = name.split('/') if name else []
    if any(value in ('', '.', '..') or '\x00' in value for value in values) or len(values) > 160:
        raise ValueError('Invalid cleanup path')
    return values
root_set = set(roots)
def inside(name):
    values = parts(name)
    return any('/'.join(values[:length]) in root_set for length in range(1, len(values) + 1))
def opened(name):
    fd = os.dup(3)
    try:
        for part in parts(name):
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise
def parent(name):
    values = parts(name)
    return opened('/'.join(values[:-1])), values[-1]
def identity(name, info):
    kind = 'directory' if stat.S_ISDIR(info.st_mode) else 'file' if stat.S_ISREG(info.st_mode) else 'link' if stat.S_ISLNK(info.st_mode) else None
    if not kind:
        raise ValueError('Cleanup contains a device, socket, or other unsupported entry')
    return dict(path=name, kind=kind, device=str(info.st_dev), inode=str(info.st_ino), mode=info.st_mode, size=info.st_size, modified=str(info.st_mtime_ns), blocks=info.st_blocks, links=info.st_nlink)
def anchor(name, info):
    return dict(path=name, device=str(info.st_dev), inode=str(info.st_ino))
def same(current, expected):
    keys = ['kind', 'device', 'inode', 'mode']
    if expected['kind'] != 'directory':
        keys += ['size', 'modified']
    if any(current[key] != expected[key] for key in keys):
        raise ValueError('Selected content changed; no replacement will be removed')
if data['mode'] == 'scan':
    entries, anchors = {}, {}
    def visit(name, depth=0):
        if depth > 128 or len(entries) >= 100000:
            raise ValueError('Cleanup exceeds the maintenance inspection limit')
        try:
            fd, leaf = parent(name)
        except FileNotFoundError:
            return
        try:
            try:
                info = os.stat(leaf, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                return
            item = identity(name, info)
            entries[name] = item
            if item['kind'] == 'directory':
                child = os.open(leaf, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    same(identity(name, os.fstat(child)), item)
                    names = sorted(os.listdir(child))
                finally:
                    os.close(child)
                for value in names:
                    visit(name + '/' + value, depth + 1)
        finally:
            os.close(fd)
    for root in roots:
        components = parts(root)
        for length in range(len(components)):
            name = '/'.join(components[:length])
            if name in anchors:
                continue
            try:
                fd = opened(name)
            except FileNotFoundError:
                break
            try:
                anchors[name] = anchor(name, os.fstat(fd))
            finally:
                os.close(fd)
        visit(root)
    # Every retained object must exist with its recorded length and immutable executable mode.
    for item in data['retained']:
        if not re.fullmatch(re.escape(prefix) + r'state/content/objects/[a-f0-9]{64}\.[rx]', item['path']):
            raise ValueError('Invalid retained object')
        fd, leaf = parent(item['path'])
        try:
            info = os.stat(leaf, dir_fd=fd, follow_symlinks=False)
            mode = 0o555 if item['executable'] else 0o444
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != mode or info.st_size != item['bytes']:
                raise ValueError('Required stored content cannot be verified')
        finally:
            os.close(fd)
    print(json.dumps(dict(entries=sorted(entries.values(), key=lambda item:item['path']), anchors=sorted(anchors.values(), key=lambda item:item['path']))))
elif data['mode'] == 'remove':
    fcntl.flock(4, fcntl.LOCK_EX | fcntl.LOCK_NB)
    manifest = data['manifest']
    entries = {item['path']:item for item in manifest['entries']}
    if len(entries) != len(manifest['entries']) or len(entries) > 100000:
        raise ValueError('Invalid cleanup manifest')
    for name in entries:
        parts(name)
        if not inside(name):
            raise ValueError('Manifest extends beyond the reviewed selection')
    for item in manifest['anchors']:
        fd = opened(item['path'])
        try:
            if anchor(item['path'], os.fstat(fd)) != item:
                raise ValueError('A cleanup parent directory was replaced')
        finally:
            os.close(fd)
    children = {}
    for name in entries:
        directory, _, leaf = name.rpartition('/')
        children.setdefault(directory, set()).add(leaf)
    # Verify the entire remaining selection before unlinking. Missing reviewed paths are the
    # only permitted difference during recovery; extra paths and replaced inodes stop recovery.
    for name, item in entries.items():
        try:
            fd, leaf = parent(name)
        except FileNotFoundError:
            continue
        try:
            try:
                info = os.stat(leaf, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                continue
            same(identity(name, info), item)
            if item['kind'] == 'directory':
                child = os.open(leaf, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    same(identity(name, os.fstat(child)), item)
                    if set(os.listdir(child)) - children.get(name, set()):
                        raise ValueError('Unreviewed content was added to the cleanup selection')
                finally:
                    os.close(child)
        finally:
            os.close(fd)
    removed = 0
    for directory in sorted(children, key=lambda value:(-len(parts(value)), value)):
        try:
            fd = opened(directory)
        except FileNotFoundError:
            continue
        try:
            for leaf in sorted(children[directory]):
                name = directory + '/' + leaf if directory else leaf
                item = entries[name]
                try:
                    info = os.stat(leaf, dir_fd=fd, follow_symlinks=False)
                except FileNotFoundError:
                    continue
                same(identity(name, info), item)
                if item['kind'] == 'directory':
                    os.rmdir(leaf, dir_fd=fd)
                else:
                    os.unlink(leaf, dir_fd=fd)
                removed += 1
            os.fsync(fd)
        finally:
            os.close(fd)
    print(json.dumps(dict(removed=removed)))
else:
    raise ValueError('Unknown cleanup operation')
`;
