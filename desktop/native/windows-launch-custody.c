/* Keep admission until the entire native process job drains, including Chromium
 * processes that intentionally do not inherit arbitrary file descriptors.
 * No kill-on-close or breakaway policy: losing the monitor preserves work and
 * leaves durable evidence that blocks mutation until a verified new OS boot. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <objbase.h>
#include <stdio.h>
#include <string.h>
#include "windows-launch-custody.h"

/* SystemBootEnvironmentInformation's ABI is documented by the phnt project:
 * https://github.com/winsiderss/systeminformer/blob/master/phnt/include/ntexapi.h
 * Windows SDK winternl.h omits this class. Resolve it only from loaded ntdll;
 * an unavailable/changed ABI refuses admission, never falls back to wall time. */
typedef struct { GUID identifier; ULONG firmware; ULONGLONG flags; } BootEnvironment;
typedef LONG (NTAPI *QuerySystemInformation)(ULONG, PVOID, ULONG, PULONG);
typedef char BootEnvironmentMustBe32Bytes[sizeof(BootEnvironment) == 32 ? 1 : -1];
typedef struct { BYTE magic[8]; GUID boot; } LaunchMarker;
static const BYTE marker_magic[8] = { 'Q', 'D', 'L', 'A', 'U', 'N', 'C', 1 };

static int boot_identifier(GUID *identifier) {
    HMODULE module = GetModuleHandleW(L"ntdll.dll");
    union { FARPROC raw; QuerySystemInformation query; } function;
    function.raw = module ? GetProcAddress(module, "NtQuerySystemInformation") : NULL;
    BootEnvironment environment = {0};
    ULONG returned = 0;
    GUID zero = {0};
    if (!function.raw || function.query(90, &environment, sizeof(environment), &returned) < 0 ||
        returned != sizeof(environment) || !memcmp(&environment.identifier, &zero, sizeof(zero))) return 0;
    *identifier = environment.identifier;
    return 1;
}

int quarterdeck_launches_drained(const wchar_t *lock) {
    GUID boot;
    wchar_t pattern[32768], path[32768];
    if (!boot_identifier(&boot) || swprintf_s(pattern, 32768, L"%ls.launch-*", lock) < 0) return 0;
    WIN32_FIND_DATAW entry;
    HANDLE search = FindFirstFileW(pattern, &entry);
    if (search == INVALID_HANDLE_VALUE) return GetLastError() == ERROR_FILE_NOT_FOUND;
    int valid = 1;
    unsigned count = 0;
    const wchar_t *slash = wcsrchr(lock, L'\\');
    if (!slash) { FindClose(search); return 0; }
    do {
        if (++count > 128 || swprintf_s(path, 32768, L"%.*ls\\%ls", (int)(slash - lock), lock, entry.cFileName) < 0) {
            valid = 0; break;
        }
        HANDLE file = CreateFileW(path, GENERIC_READ | DELETE | READ_CONTROL, 0, NULL, OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT, NULL);
        BY_HANDLE_FILE_INFORMATION info;
        LaunchMarker marker;
        DWORD read = 0;
        valid = file != INVALID_HANDLE_VALUE && GetFileInformationByHandle(file, &info) &&
            info.nNumberOfLinks == 1 && !(info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) &&
            info.nFileSizeHigh == 0 && info.nFileSizeLow == sizeof(marker) && quarterdeck_private_handle(file) &&
            ReadFile(file, &marker, sizeof(marker), &read, NULL) && read == sizeof(marker) &&
            !memcmp(marker.magic, marker_magic, sizeof(marker_magic)) && memcmp(&marker.boot, &boot, sizeof(boot));
        if (valid) {
            FILE_DISPOSITION_INFO disposition = {TRUE};
            valid = SetFileInformationByHandle(file, FileDispositionInfo, &disposition, sizeof(disposition));
        }
        if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
        if (!valid) break;
    } while (FindNextFileW(search, &entry));
    if (valid && GetLastError() != ERROR_NO_MORE_FILES) valid = 0;
    FindClose(search);
    return valid;
}

int quarterdeck_begin_launch(const wchar_t *lock, QuarterdeckLaunchCustody *custody) {
    LaunchMarker marker;
    GUID launch;
    wchar_t identifier[40];
    memset(custody, 0, sizeof(*custody));
    custody->marker = INVALID_HANDLE_VALUE;
    memcpy(marker.magic, marker_magic, sizeof(marker_magic));
    if (!boot_identifier(&marker.boot) || FAILED(CoCreateGuid(&launch)) ||
        !StringFromGUID2(&launch, identifier, 40) ||
        swprintf_s(custody->path, 32768, L"%ls.launch-%ls", lock, identifier) < 0) return 0;
    custody->marker = CreateFileW(custody->path, GENERIC_WRITE | DELETE | READ_CONTROL, FILE_SHARE_READ,
        NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH, NULL);
    DWORD written = 0;
    int valid = custody->marker != INVALID_HANDLE_VALUE && quarterdeck_private_handle(custody->marker) &&
        WriteFile(custody->marker, &marker, sizeof(marker), &written, NULL) && written == sizeof(marker) &&
        FlushFileBuffers(custody->marker);
    wchar_t job_name[96];
    int named=swprintf_s(job_name,96,L"Local\\Quarterdeck-Launch-%ls",identifier)>0;
    custody->job = valid && named ? CreateJobObjectW(NULL, job_name) : NULL;
    if(custody->job && GetLastError()==ERROR_ALREADY_EXISTS){CloseHandle(custody->job);custody->job=NULL;}
    /* Assign this bootstrap before starting any host instruction, so no process
     * can escape through a create-then-assign race. Descendants inherit the job. */
    if (!custody->job || !AssignProcessToJobObject(custody->job, GetCurrentProcess())) {
        if (custody->job) CloseHandle(custody->job);
        if (custody->marker != INVALID_HANDLE_VALUE) {
            CloseHandle(custody->marker);
            DeleteFileW(custody->path); /* no host instruction has run */
        }
        return 0;
    }
    return 1;
}

int quarterdeck_end_launch(QuarterdeckLaunchCustody *custody) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
    for (;;) {
        if (!QueryInformationJobObject(custody->job, JobObjectBasicAccountingInformation,
            &accounting, sizeof(accounting), NULL)) return 0;
        if (accounting.ActiveProcesses == 1) break; /* this bootstrap only */
        Sleep(100);
    }
    FILE_DISPOSITION_INFO disposition = {TRUE};
    int removed = SetFileInformationByHandle(custody->marker, FileDispositionInfo, &disposition, sizeof(disposition));
    CloseHandle(custody->marker);
    CloseHandle(custody->job);
    return removed;
}
