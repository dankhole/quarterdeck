/* OS-only Windows admission. No Electron, Node, shell, or package code runs here. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <tlhelp32.h>
#include <shlobj.h>
#include <fcntl.h>
#include <io.h>
#include <process.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include "windows-launch-custody.h"

#define ADMISSION_FD 198
#define PATH_CAPACITY 32768
extern int quarterdeck_shortcut(int operation);
extern int quarterdeck_shortcut_paths(const wchar_t *target, const wchar_t *path, int operation);
extern int quarterdeck_update_window(const wchar_t *script);

#ifndef QUARTERDECK_ADMISSION_TEST
static HRESULT login_profile(PWSTR *profile) {
#ifdef QUARTERDECK_ADMISSION_LAB_PROFILE
    size_t bytes = sizeof(QUARTERDECK_ADMISSION_LAB_PROFILE);
    *profile = (PWSTR)CoTaskMemAlloc(bytes);
    if (!*profile) return E_OUTOFMEMORY;
    memcpy(*profile, QUARTERDECK_ADMISSION_LAB_PROFILE, bytes);
    return S_OK;
#else
    return SHGetKnownFolderPath(&FOLDERID_Profile, 0, NULL, profile);
#endif
}
#endif

static int refuse(const char *message) {
    fprintf(stderr, "Quarterdeck installation admission: %s\n", message);
    return 73;
}

static int current_user_sid(BYTE *buffer, DWORD capacity, PSID *sid) {
    HANDLE token = NULL;
    DWORD required = 0;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return 0;
    BOOL ok = GetTokenInformation(token, TokenUser, buffer, capacity, &required);
    CloseHandle(token);
    if (!ok) return 0;
    *sid = ((TOKEN_USER *)buffer)->User.Sid;
    return IsValidSid(*sid);
}

/* Protected metadata admits only the current user and LocalSystem. */
int quarterdeck_private_handle(HANDLE file) {
    BYTE token[4096];
    PSID user = NULL, owner = NULL;
    BYTE system_buffer[SECURITY_MAX_SID_SIZE];
    DWORD system_size = sizeof(system_buffer);
    PACL dacl = NULL;
    PSECURITY_DESCRIPTOR security = NULL;
    SECURITY_DESCRIPTOR_CONTROL control = 0;
    DWORD revision = 0;
    if (!current_user_sid(token, sizeof(token), &user) ||
        !CreateWellKnownSid(WinLocalSystemSid, NULL, system_buffer, &system_size)) return 0;
    if (GetSecurityInfo(file, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        &owner, NULL, &dacl, NULL, &security) != ERROR_SUCCESS) return 0;
    int ok = owner && EqualSid(owner, user) && dacl &&
        GetSecurityDescriptorControl(security, &control, &revision);
    int user_access = 0;
    for (DWORD i = 0; ok && i < dacl->AceCount; ++i) {
        void *ace = NULL;
        if (!GetAce(dacl, i, &ace)) { ok = 0; break; }
        ACE_HEADER *header = (ACE_HEADER *)ace;
        if (header->AceFlags & INHERIT_ONLY_ACE) continue;
        if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) { ok = 0; break; }
        ACCESS_ALLOWED_ACE *allowed = (ACCESS_ALLOWED_ACE *)ace;
        PSID trustee = (PSID)&allowed->SidStart;
        if (!IsValidSid(trustee) || (!EqualSid(trustee, user) && !EqualSid(trustee, system_buffer))) ok = 0;
        if (EqualSid(trustee, user) && (allowed->Mask & (GENERIC_ALL | FILE_ALL_ACCESS)) == FILE_ALL_ACCESS)
            user_access = 1;
    }
    LocalFree(security);
    return ok && user_access;
}

static int absolute_local_path(const wchar_t *path) {
    return path && wcslen(path) > 3 &&
        ((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z')) &&
        path[1] == L':' && path[2] == L'\\';
}

int quarterdeck_safe_ancestors(const wchar_t *path, int protected_parent) {
    wchar_t current[PATH_CAPACITY];
    if (!absolute_local_path(path) || wcslen(path) >= PATH_CAPACITY) return 0;
    wcscpy_s(current, PATH_CAPACITY, path);
    wchar_t *slash = wcsrchr(current, L'\\');
    if (!slash || slash <= current + 2) return 0;
    *slash = L'\0';
    int first = 1;
    while (wcslen(current) > 3) {
        HANDLE directory = CreateFileW(current, READ_CONTROL | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
        if (directory == INVALID_HANDLE_VALUE) return 0;
        BY_HANDLE_FILE_INFORMATION info;
        int ok = GetFileInformationByHandle(directory, &info) &&
            (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) &&
            !(info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) && (!protected_parent || !first || quarterdeck_private_handle(directory));
        CloseHandle(directory);
        if (!ok) return 0;
        first = 0;
        slash = wcsrchr(current, L'\\');
        if (!slash) return 0;
        if (slash == current + 2) break;
        *slash = L'\0';
    }
    return 1;
}

static HANDLE open_lock(const wchar_t *path, int exclusive) {
    if (!quarterdeck_safe_ancestors(path, 1)) return INVALID_HANDLE_VALUE;
    SECURITY_ATTRIBUTES attributes = { sizeof(SECURITY_ATTRIBUTES), NULL, TRUE };
    HANDLE file = CreateFileW(path, GENERIC_READ | READ_CONTROL,
        exclusive ? 0 : FILE_SHARE_READ, &attributes, OPEN_ALWAYS,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    if (file == INVALID_HANDLE_VALUE) return file;
    BY_HANDLE_FILE_INFORMATION info;
    if (!GetFileInformationByHandle(file, &info) || info.nNumberOfLinks != 1 ||
        (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) ||
        GetFileType(file) != FILE_TYPE_DISK || !quarterdeck_private_handle(file)) {
        CloseHandle(file);
        return INVALID_HANDLE_VALUE;
    }
    return file;
}

static int same_lock(HANDLE file, const wchar_t *path) {
    wchar_t actual[PATH_CAPACITY];
    DWORD size = GetFinalPathNameByHandleW(file, actual, PATH_CAPACITY, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    return size > 4 && size < PATH_CAPACITY && !wcsncmp(actual, L"\\\\?\\", 4) &&
        !_wcsicmp(actual + 4, path) && quarterdeck_private_handle(file);
}

static HANDLE invoking_parent(ULONGLONG *birth) {
    DWORD parent_id = 0;
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return NULL;
    PROCESSENTRY32W row = {0};
    row.dwSize = sizeof(row);
    if (Process32FirstW(snapshot, &row)) do {
        if (row.th32ProcessID == GetCurrentProcessId()) { parent_id = row.th32ParentProcessID; break; }
    } while (Process32NextW(snapshot, &row));
    CloseHandle(snapshot);
    if (!parent_id) return NULL;
    HANDLE parent = OpenProcess(PROCESS_DUP_HANDLE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, parent_id);
    if (!parent) return NULL;
    FILETIME created, exited, kernel, user, child_created;
    if (!GetProcessTimes(parent, &created, &exited, &kernel, &user) ||
        !GetProcessTimes(GetCurrentProcess(), &child_created, &exited, &kernel, &user) ||
        CompareFileTime(&created, &child_created) > 0) { CloseHandle(parent); return NULL; }
    *birth = ((ULONGLONG)created.dwHighDateTime << 32) | created.dwLowDateTime;
    return parent;
}

/* Duplicate into the installer process: helper death cannot release its mutation admission. */
static int acquire_mutation(const wchar_t *path) {
    HANDLE file = open_lock(path, 1);
    if (file == INVALID_HANDLE_VALUE) return refuse("installation is in use or its protected lock is invalid.");
    if (!quarterdeck_launches_drained(path)) {
        CloseHandle(file);
        refuse("a native launch did not confirm all descendants exited. Restart Windows before installing or updating Quarterdeck.");
        return 74;
    }
    ULONGLONG birth = 0;
    HANDLE parent = invoking_parent(&birth), duplicate = NULL;
    if (!parent || !DuplicateHandle(GetCurrentProcess(), file, parent, &duplicate, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
        if (parent) CloseHandle(parent);
        CloseHandle(file);
        return refuse("could not retain mutation admission in the installer.");
    }
    CloseHandle(file);
    printf("{\"handle\":\"%llx\",\"birth\":\"%llx\"}\n", (unsigned long long)(uintptr_t)duplicate, birth);
    fflush(stdout);
    CloseHandle(parent);
    return 0;
}

static int release_mutation(const wchar_t *path, const wchar_t *handle_value, const wchar_t *birth_value) {
    wchar_t *end = NULL;
    unsigned long long value = wcstoull(handle_value, &end, 16);
    if (!end || *end || !value || value > UINTPTR_MAX) return refuse("invalid mutation handle.");
    unsigned long long expected_birth = wcstoull(birth_value, &end, 16);
    if (!end || *end || !expected_birth) return refuse("invalid installer identity.");
    ULONGLONG birth = 0;
    HANDLE parent = invoking_parent(&birth), copy = NULL;
    if (!parent || birth != expected_birth ||
        !DuplicateHandle(parent, (HANDLE)(uintptr_t)value, GetCurrentProcess(), &copy, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
        if (parent) CloseHandle(parent);
        return refuse("installer identity changed or its admission is unavailable.");
    }
    if (!same_lock(copy, path)) { CloseHandle(copy); CloseHandle(parent); return refuse("mutation handle changed."); }
    CloseHandle(copy);
    BOOL ok = DuplicateHandle(parent, (HANDLE)(uintptr_t)value, GetCurrentProcess(), &copy, 0, FALSE,
        DUPLICATE_SAME_ACCESS | DUPLICATE_CLOSE_SOURCE);
    if (ok) CloseHandle(copy);
    CloseHandle(parent);
    return ok ? 0 : refuse("could not release installer admission.");
}

/* _spawnv concatenates its arguments; apply the Windows CRT quoting rules explicitly. */
static wchar_t *quote_argument(const wchar_t *value) {
    size_t length = wcslen(value);
    if (length > 32767) return NULL;
    wchar_t *result = (wchar_t *)calloc(length * 2 + 3, sizeof(wchar_t));
    if (!result) return NULL;
    wchar_t *out = result;
    *out++ = L'"';
    size_t slashes = 0;
    for (const wchar_t *cursor = value; ; ++cursor) {
        if (*cursor == L'\\') { ++slashes; continue; }
        size_t count = (*cursor == L'"' || !*cursor) ? slashes * 2 : slashes;
        while (count--) *out++ = L'\\';
        slashes = 0;
        if (!*cursor) break;
        if (*cursor == L'"') *out++ = L'\\';
        *out++ = *cursor;
    }
    *out++ = L'"';
    *out = L'\0';
    return result;
}

static int launch_admitted(const wchar_t *lock, const wchar_t *host, const wchar_t *const *args) {
    HANDLE file = open_lock(lock, 0);
    if (file == INVALID_HANDLE_VALUE) return refuse("an installation operation is running or admission is invalid.");
    if (!quarterdeck_safe_ancestors(host, 0)) { CloseHandle(file); return refuse("desktop host has a reparse-point ancestor."); }
    int descriptor = _open_osfhandle((intptr_t)file, _O_RDONLY | _O_BINARY);
    if (descriptor < 0) { CloseHandle(file); return refuse("could not retain shared admission."); }
    if (descriptor != ADMISSION_FD) {
        if (_dup2(descriptor, ADMISSION_FD)) { _close(descriptor); return refuse("could not inherit admission."); }
        _close(descriptor);
    }
    if (_wputenv_s(L"QUARTERDECK_INSTALLATION_LOCK_FD", L"198") ||
        _wputenv_s(L"QUARTERDECK_INSTALLATION_LOCK_PATH", lock)) return refuse("could not publish admission.");
    size_t count = 0;
    while (args[count]) ++count;
    wchar_t **quoted = (wchar_t **)calloc(count + 1, sizeof(wchar_t *));
    if (!quoted) { _close(ADMISSION_FD); return refuse("could not prepare native launch."); }
    int valid = 1;
    for (size_t i = 0; i < count; ++i) {
        quoted[i] = quote_argument(args[i]);
        if (!quoted[i]) valid = 0;
    }
    QuarterdeckLaunchCustody custody;
    if (!valid || !quarterdeck_begin_launch(lock, &custody)) {
        for (size_t i = 0; i < count; ++i) free(quoted[i]);
        free(quoted);
        _close(ADMISSION_FD);
        return refuse("could not establish native descendant custody.");
    }
    intptr_t result = valid ? _wspawnv(_P_WAIT, host, (const wchar_t *const *)quoted) : -1;
    for (size_t i = 0; i < count; ++i) free(quoted[i]);
    free(quoted);
    int drained = quarterdeck_end_launch(&custody);
    _close(ADMISSION_FD);
    if (!drained) return refuse("native descendant custody could not be released. Restart Windows before updating.");
    return result < 0 ? refuse("could not launch the admitted host.") : (int)result;
}

int wmain(int argc, wchar_t **argv) {
#ifdef QUARTERDECK_ADMISSION_LAB_PROFILE
    if (argc == 2 && !wcscmp(argv[1], L"--quarterdeck-test-check-shortcut")) return quarterdeck_shortcut(2);
#endif
#if defined(QUARTERDECK_ADMISSION_TEST) || defined(QUARTERDECK_ADMISSION_LAB_PROFILE)
    if(argc==4 && !wcscmp(argv[1],L"--quarterdeck-test-job-member")) {
        GUID identifier; wchar_t canonical[40], name[96], *end=NULL;
        unsigned long pid=wcstoul(argv[3],&end,10);
        if(!pid || !end || *end || FAILED(CLSIDFromString(argv[2],&identifier)) || !StringFromGUID2(&identifier,canonical,40) || swprintf_s(name,96,L"Local\\Quarterdeck-Launch-%ls",canonical)<0) return 73;
        HANDLE job=OpenJobObjectW(JOB_OBJECT_QUERY,FALSE,name), process=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid);
        BOOL member=FALSE;
        int valid=job && process && IsProcessInJob(process,job,&member) && member;
        if(job) CloseHandle(job); if(process) CloseHandle(process);
        return valid?0:73;
    }
#endif
    if (argc == 3 && !wcscmp(argv[1], L"--quarterdeck-update-window")) return quarterdeck_update_window(argv[2]);
    if (argc >= 2 && ((!wcscmp(argv[1], L"--quarterdeck-acquire-mutation") && argc != 3) ||
        (!wcscmp(argv[1], L"--quarterdeck-release-mutation") && argc != 5)))
        return refuse("invalid installation operation arguments.");
#ifdef QUARTERDECK_ADMISSION_TEST
    if (argc == 5 && !wcscmp(argv[1], L"--quarterdeck-test-shortcut")) {
        int operation = !wcscmp(argv[2], L"install") ? 0 : !wcscmp(argv[2], L"remove") ? 1 : !wcscmp(argv[2], L"check") ? 2 : -1;
        return operation < 0 ? 73 : quarterdeck_shortcut_paths(argv[3], argv[4], operation);
    }
    if (argc >= 5 && !wcscmp(argv[1], L"--quarterdeck-test-exec"))
        return launch_admitted(argv[2], argv[3], (const wchar_t *const *)&argv[3]);
    const wchar_t *lock = argc >= 3 ? argv[2] : NULL;
#else
    if (argc == 2 && !wcscmp(argv[1], L"--quarterdeck-shortcut-install")) return quarterdeck_shortcut(0);
    if (argc == 2 && !wcscmp(argv[1], L"--quarterdeck-shortcut-remove")) return quarterdeck_shortcut(1);
    if (argc >= 2 && !wcscmp(argv[1], L"--quarterdeck-test-shortcut")) return refuse("synthetic shortcuts are not a production entrypoint.");
    if (argc >= 2 && !wcscmp(argv[1], L"--quarterdeck-test-exec")) return refuse("synthetic launch is not a production entrypoint.");
#ifndef QUARTERDECK_ADMISSION_LAB_PROFILE
    if(argc>=2 && !wcsncmp(argv[1],L"--quarterdeck-test-",19)) return refuse("synthetic inspection is not a production entrypoint.");
#endif
    PWSTR profile = NULL;
    static wchar_t canonical_lock[PATH_CAPACITY];
    if (FAILED(login_profile(&profile))) return refuse("login profile is unavailable.");
    int written = swprintf_s(canonical_lock, PATH_CAPACITY,
        L"%ls\\AppData\\Local\\Quarterdeck\\installation\\admission.lock", profile);
    CoTaskMemFree(profile);
    if (written < 0) return refuse("installation path is too long.");
    const wchar_t *lock = canonical_lock;
    if (argc >= 3 && (!wcscmp(argv[1], L"--quarterdeck-acquire-mutation") ||
        !wcscmp(argv[1], L"--quarterdeck-release-mutation")) && _wcsicmp(argv[2], lock))
        return refuse("the installation lock path is not canonical.");
#endif
    if (argc == 3 && !wcscmp(argv[1], L"--quarterdeck-acquire-mutation")) return acquire_mutation(lock);
    if (argc == 5 && !wcscmp(argv[1], L"--quarterdeck-release-mutation"))
        return release_mutation(lock, argv[3], argv[4]);
#ifndef QUARTERDECK_ADMISSION_TEST
    static wchar_t executable[PATH_CAPACITY], app[PATH_CAPACITY], host[PATH_CAPACITY];
    if (FAILED(login_profile(&profile))) return refuse("login profile is unavailable.");
    written = swprintf_s(app, PATH_CAPACITY, L"%ls\\AppData\\Local\\Programs\\Quarterdeck\\", profile);
    CoTaskMemFree(profile);
    DWORD length = GetModuleFileNameW(NULL, executable, PATH_CAPACITY);
    if (written < 0 || !length || length >= PATH_CAPACITY || _wcsnicmp(executable, app, wcslen(app)))
        return refuse("open the npm-managed Quarterdeck app or repair desktop installation.");
    const wchar_t *relative = executable + wcslen(app);
    if (!wcscmp(relative, L"Quarterdeck.exe")) written = swprintf_s(host, PATH_CAPACITY, L"%lshost\\Quarterdeck.exe", app);
    else if (!wcscmp(relative, L"host\\resources\\runtime\\bin\\node.exe"))
        written = swprintf_s(host, PATH_CAPACITY, L"%lshost\\resources\\runtime\\bin\\nodeHost.exe", app);
    else return refuse("unrecognized native desktop entrypoint.");
    if (written < 0) return refuse("desktop host path is too long.");
    argv[0] = host;
    return launch_admitted(lock, host, (const wchar_t *const *)argv);
#else
    return refuse("this native Windows admission helper requires an explicit installation operation.");
#endif
}
