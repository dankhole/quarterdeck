/*
 * The admission stub depends only on the OS. It acquires the permanent lock
 * before loading Electron or any bundle resource. An old stub awakened after
 * replacement resolves the current host under that lock, never its old bundle.
 */
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pwd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif

#define ADMISSION_FD 198

static int approved_entry(const char *relative) {
    const char *entries[] = {
        "Contents/MacOS/Quarterdeck",
        "Contents/Resources/runtime/bin/node",
        "Contents/Frameworks/Quarterdeck Helper.app/Contents/MacOS/Quarterdeck Helper",
        "Contents/Frameworks/Quarterdeck Helper (GPU).app/Contents/MacOS/Quarterdeck Helper (GPU)",
        "Contents/Frameworks/Quarterdeck Helper (Renderer).app/Contents/MacOS/Quarterdeck Helper (Renderer)",
        "Contents/Frameworks/Quarterdeck Helper (Plugin).app/Contents/MacOS/Quarterdeck Helper (Plugin)",
        "Contents/Frameworks/Quarterdeck Helper (Utility).app/Contents/MacOS/Quarterdeck Helper (Utility)",
        "Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler",
        NULL
    };
    for (int i = 0; entries[i]; i++) if (!strcmp(relative, entries[i])) return 1;
    return 0;
}

static int host_path(char *output, size_t size, const char *entry) {
    const char *name = strrchr(entry, '/');
    if (!name) return -1;
    name++;
    /* Electron locates the outer bundle using the Helper/(Renderer)/(GPU) suffix. */
    if (!strncmp(name, "Quarterdeck Helper", strlen("Quarterdeck Helper")))
        return snprintf(output, size, "%.*sQuarterdeckHost%s", (int)(name - entry), entry, name + strlen("Quarterdeck")) >= (int)size ? -1 : 0;
    return snprintf(output, size, "%sHost", entry) >= (int)size ? -1 : 0;
}

static int refusal(const char *message) {
    fprintf(stderr, "Quarterdeck installation admission: %s\n", message);
    return 73;
}

static int safe_ancestors(const char *path) {
    char current[PATH_MAX];
    struct stat info;
    if (path[0] != '/' || strlen(path) >= sizeof(current)) return 0;
    strcpy(current, path);
    char *slash = strrchr(current, '/');
    if (!slash) return 0;
    *slash = '\0';
    while (current[0]) {
        if (lstat(current, &info) ||
            (S_ISLNK(info.st_mode) ? info.st_uid != 0 : !S_ISDIR(info.st_mode))) return 0;
        slash = strrchr(current, '/');
        if (!slash) return 0;
        *slash = '\0';
    }
    return 1;
}

static int open_lock(const char *path, int exclusive) {
    struct stat parent_info, info;
    char parent[PATH_MAX];
    if (!safe_ancestors(path) || strlen(path) >= sizeof(parent)) return -1;
    strcpy(parent, path);
    char *slash = strrchr(parent, '/');
    if (!slash || slash == parent) return -1;
    *slash = '\0';
    if (lstat(parent, &parent_info) || !S_ISDIR(parent_info.st_mode) ||
        parent_info.st_uid != getuid() || (parent_info.st_mode & 0077)) return -1;
    int fd = open(path, O_RDWR | O_CREAT | O_NOFOLLOW, 0600);
    if (fd < 0) return -1;
    if (fstat(fd, &info) || !S_ISREG(info.st_mode) || info.st_uid != getuid() ||
        (info.st_mode & 0077) || info.st_nlink != 1) {
        close(fd);
        return -1;
    }
    if (flock(fd, (exclusive ? LOCK_EX : LOCK_SH) | LOCK_NB)) {
        close(fd);
        return -1;
    }
    return fd;
}

static int hold_exclusive(const char *path) {
    int fd = open_lock(path, 1);
    if (fd < 0) return refusal("installation is in use or its lock cannot be verified; quit and retry.");
    puts("QUARTERDECK_INSTALLATION_LOCK_READY");
    fflush(stdout);
    char bytes[128];
    while (read(STDIN_FILENO, bytes, sizeof(bytes)) > 0) {}
    /* Never LOCK_UN: inherited descriptors must retain lifetime protection. */
    close(fd);
    return 0;
}

static int lock_inherited(const char *path) {
    struct stat descriptor, named;
    /* Node keeps fd3's open-file description after this process exits. */
    if (!safe_ancestors(path) || fstat(3, &descriptor) || lstat(path, &named) || !S_ISREG(descriptor.st_mode) ||
        descriptor.st_uid != getuid() || (descriptor.st_mode & 0077) || descriptor.st_nlink != 1 ||
        descriptor.st_dev != named.st_dev || descriptor.st_ino != named.st_ino || S_ISLNK(named.st_mode))
        return refusal("the inherited installation lock is invalid.");
    if (flock(3, LOCK_EX | LOCK_NB)) return refusal("the installation is in use; quit and retry.");
    return 0;
}

static int exec_with_admission(const char *lock, const char *host, char **args) {
    int fd = open_lock(lock, 0);
    if (fd < 0) return refusal("an installation operation is running; retry after it finishes.");
    if (fd != ADMISSION_FD) {
        if (dup2(fd, ADMISSION_FD) < 0) return refusal("could not preserve the native admission descriptor.");
        close(fd);
    }
    if (fcntl(ADMISSION_FD, F_SETFD, 0) < 0) return refusal("could not retain admission across launch.");
    setenv("QUARTERDECK_INSTALLATION_LOCK_FD", "198", 1);
    setenv("QUARTERDECK_INSTALLATION_LOCK_PATH", lock, 1);
    execv(host, args);
    return refusal("could not load the current installed application.");
}

int main(int argc, char **argv) {
    if (argc == 3 && !strcmp(argv[1], "--quarterdeck-install-lock")) return hold_exclusive(argv[2]);
    if (argc == 3 && !strcmp(argv[1], "--quarterdeck-install-lock-fd")) return lock_inherited(argv[2]);
#ifdef QUARTERDECK_ADMISSION_TEST
    if (argc >= 5 && !strcmp(argv[1], "--quarterdeck-test-exec"))
        return exec_with_admission(argv[2], argv[3], &argv[3]);
#endif
#ifdef __APPLE__
    struct passwd *user = getpwuid(getuid());
    if (!user || !user->pw_dir || getuid() == 0) return refusal("use a user-owned npm installation.");
    const char *home = user->pw_dir;
#ifdef QUARTERDECK_ADMISSION_TEST_HOME
    /* Compile-time only: production artifacts never accept a home override. */
    home = QUARTERDECK_ADMISSION_TEST_HOME;
#endif
    char app[PATH_MAX], lock[PATH_MAX], host[PATH_MAX], executable[PATH_MAX];
    uint32_t length = sizeof(executable);
    if (_NSGetExecutablePath(executable, &length)) return refusal("the executable path is unavailable.");
    if (snprintf(app, sizeof(app), "%s/Applications/Quarterdeck.app/", home) >= (int)sizeof(app) ||
        snprintf(lock, sizeof(lock), "%s/Library/Application Support/Quarterdeck/installation/admission.lock", home) >= (int)sizeof(lock))
        return refusal("the installation path is too long.");
    char canonical[PATH_MAX];
    if (!realpath(executable, canonical)) return refusal("the application path is unavailable.");
    const char *relative = !strncmp(canonical, app, strlen(app)) ? canonical + strlen(app) : NULL;
    if (!relative || !approved_entry(relative)) {
        /* Lab candidates are copied into an isolated tree, never the user app. */
        if (!getenv("QUARTERDECK_DESKTOP_LAB_CONFIG"))
            return refusal("open the npm-managed app in ~/Applications, or run quarterdeck desktop install.");
        if (host_path(host, sizeof(host), canonical))
            return refusal("the lab application path is too long.");
        unsetenv("QUARTERDECK_INSTALLATION_LOCK_FD");
        unsetenv("QUARTERDECK_INSTALLATION_LOCK_PATH");
        execv(host, argv);
        return refusal("could not load the isolated application.");
    }
    char current[PATH_MAX];
    if (snprintf(current, sizeof(current), "%s%s", app, relative) >= (int)sizeof(current) || host_path(host, sizeof(host), current))
        return refusal("the host path is too long.");
    return exec_with_admission(lock, host, argv);
#else
    return refusal("native application admission requires macOS.");
#endif
}
