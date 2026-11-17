#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shlobj.h>
#include <propkey.h>
#include <propvarutil.h>
#include <wrl/client.h>
#include <string>

using Microsoft::WRL::ComPtr;
static const wchar_t *app_id = L"io.github.dankhole.quarterdeck";
static const DWORD fixed_target_flags = SLDF_FORCE_NO_LINKTRACK | SLDF_DISABLE_LINK_PATH_TRACKING;

static int shortcut_operation(const wchar_t *target, const wchar_t *path, int operation) {
    ComPtr<IShellLinkW> link;
    if (FAILED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&link)))) return 73;
    ComPtr<IPersistFile> persisted;
    ComPtr<IPropertyStore> properties;
    if (FAILED(link.As(&persisted)) || FAILED(link.As(&properties))) return 73;
    DWORD attributes = GetFileAttributesW(path);
    if (attributes != INVALID_FILE_ATTRIBUTES) {
        if (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) return 73;
        wchar_t current[32768], arguments[32768];
        PROPVARIANT identity;
        PropVariantInit(&identity);
        // Recover only our exact retargeted entry, with the same app ID and no arguments.
        std::wstring host;
        const std::wstring bootstrap(target);
        const auto separator = bootstrap.find_last_of(L"\\/");
        if (separator != std::wstring::npos &&
            !_wcsicmp(bootstrap.c_str() + separator + 1, L"Quarterdeck.exe"))
            host = bootstrap.substr(0, separator + 1) + L"QuarterdeckHost.exe";
        bool owned = SUCCEEDED(persisted->Load(path, STGM_READ)) &&
            SUCCEEDED(link->GetPath(current, 32768, nullptr, SLGP_RAWPATH)) &&
            (!_wcsicmp(current, target) || (!host.empty() && !_wcsicmp(current, host.c_str()))) &&
            SUCCEEDED(link->GetArguments(arguments, 32768)) && !arguments[0] &&
            SUCCEEDED(properties->GetValue(PKEY_AppUserModel_ID, &identity)) && identity.vt == VT_LPWSTR &&
            identity.pwszVal && !wcscmp(identity.pwszVal, app_id);
        PropVariantClear(&identity);
        if (!owned) return operation == 1 ? 0 : 73;
        if (operation == 1) return DeleteFileW(path) ? 0 : 73;
        if (operation == 2) {
            ComPtr<IShellLinkDataList> data;
            DWORD flags = 0;
            return !_wcsicmp(current, target) && SUCCEEDED(link.As(&data)) && SUCCEEDED(data->GetFlags(&flags)) &&
                (flags & fixed_target_flags) == fixed_target_flags ? 0 : 73;
        }
    } else {
        if (GetLastError() != ERROR_FILE_NOT_FOUND && GetLastError() != ERROR_PATH_NOT_FOUND) return 73;
        if (operation == 1) return 0;
        if (operation == 2) return 73;
    }
    // Loading an existing link read-only also makes its property store read-only.
    // Build a fresh object for atomic publication; never commit into the link
    // whose ownership was just inspected.
    properties.Reset(); persisted.Reset(); link.Reset();
    if (FAILED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&link))) ||
        FAILED(link.As(&persisted)) || FAILED(link.As(&properties))) return 73;
    attributes = GetFileAttributesW(target);
    if (attributes == INVALID_FILE_ATTRIBUTES || attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) return 73;
    PROPVARIANT identity;
    PropVariantInit(&identity);
    HRESULT result = InitPropVariantFromString(app_id, &identity);
    if (SUCCEEDED(result)) result = properties->SetValue(PKEY_AppUserModel_ID, identity);
    PropVariantClear(&identity);
    if (FAILED(result) || FAILED(properties->Commit()) || FAILED(link->SetPath(target)) ||
        FAILED(link->SetArguments(L"")) || FAILED(link->SetDescription(L"Quarterdeck coding agents")) ||
        FAILED(link->SetIconLocation(target, 0))) return 73;
    // The canonical install path stays fixed across replacements. Do not let
    // Explorer resolve a different executable through link tracking.
    ComPtr<IShellLinkDataList> data;
    DWORD flags = 0;
    if (FAILED(link.As(&data)) || FAILED(data->GetFlags(&flags)) ||
        FAILED(data->SetFlags(flags | fixed_target_flags))) return 73;
    GUID id;
    wchar_t suffix[40];
    if (FAILED(CoCreateGuid(&id)) || !StringFromGUID2(id, suffix, 40)) return 73;
    std::wstring temporary = std::wstring(path) + L"." + suffix + L".tmp";
    if (FAILED(persisted->Save(temporary.c_str(), TRUE))) { DeleteFileW(temporary.c_str()); return 73; }
    if (!MoveFileExW(temporary.c_str(), path, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        DeleteFileW(temporary.c_str()); return 73;
    }
    SHChangeNotify(SHCNE_UPDATEITEM, SHCNF_PATHW, path, nullptr);
    return 0;
}

extern "C" int quarterdeck_shortcut_paths(const wchar_t *target, const wchar_t *path, int operation) {
    HRESULT initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (FAILED(initialized)) return 73;
    int result = shortcut_operation(target, path, operation);
    CoUninitialize();
    return result;
}

extern "C" int quarterdeck_shortcut(int operation) {
#ifdef QUARTERDECK_ADMISSION_LAB_PROFILE
    std::wstring target = std::wstring(QUARTERDECK_ADMISSION_LAB_PROFILE) + L"\\AppData\\Local\\Programs\\Quarterdeck\\Quarterdeck.exe";
    std::wstring path = std::wstring(QUARTERDECK_ADMISSION_LAB_PROFILE) + L"\\StartMenu\\Quarterdeck.lnk";
#else
    PWSTR profile = nullptr, programs = nullptr;
    if (FAILED(SHGetKnownFolderPath(FOLDERID_Profile, 0, nullptr, &profile))) return 73;
    HRESULT result = SHGetKnownFolderPath(FOLDERID_Programs, KF_FLAG_CREATE, nullptr, &programs);
    if (FAILED(result)) { CoTaskMemFree(profile); return 73; }
    std::wstring target = std::wstring(profile) + L"\\AppData\\Local\\Programs\\Quarterdeck\\Quarterdeck.exe";
    std::wstring path = std::wstring(programs) + L"\\Quarterdeck.lnk";
    CoTaskMemFree(profile); CoTaskMemFree(programs);
#endif
    return quarterdeck_shortcut_paths(target.c_str(), path.c_str(), operation);
}
