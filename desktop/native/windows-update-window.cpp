#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shlobj.h>
#include <shldisp.h>
#include <exdisp.h>
#include <servprov.h>
#include <wrl/client.h>
#include <string>

using Microsoft::WRL::ComPtr;
extern "C" int quarterdeck_private_handle(HANDLE file);
extern "C" int quarterdeck_safe_ancestors(const wchar_t *path, int protected_parent);

class ShellValue {
public:
    VARIANT value;
    explicit ShellValue(const wchar_t *text) { VariantInit(&value); value.vt=VT_BSTR; value.bstrVal=SysAllocString(text); }
    explicit ShellValue(int number) { VariantInit(&value); value.vt=VT_I4; value.lVal=number; }
    ~ShellValue() { VariantClear(&value); }
    ShellValue(const ShellValue&)=delete;
    ShellValue& operator=(const ShellValue&)=delete;
};

static HRESULT open_from_desktop(const wchar_t *script) {
    ComPtr<IShellWindows> windows;
    HRESULT result=CoCreateInstance(CLSID_ShellWindows,nullptr,CLSCTX_LOCAL_SERVER,IID_PPV_ARGS(&windows));
    if(FAILED(result)) return result;
    VARIANT empty; VariantInit(&empty);
    ShellValue desktop(CSIDL_DESKTOP);
    long window=0;
    ComPtr<IDispatch> dispatch;
    result=windows->FindWindowSW(&desktop.value,&empty,SWC_DESKTOP,&window,SWFO_NEEDDISPATCH,&dispatch);
    if(FAILED(result) || !dispatch) return E_FAIL;
    ComPtr<IServiceProvider> provider;
    ComPtr<IShellBrowser> browser;
    ComPtr<IShellView> view;
    ComPtr<IDispatch> background;
    ComPtr<IShellFolderViewDual> folder;
    ComPtr<IDispatch> application;
    ComPtr<IShellDispatch2> shell;
    if(FAILED(dispatch.As(&provider)) || FAILED(provider->QueryService(SID_STopLevelBrowser,IID_PPV_ARGS(&browser))) ||
       FAILED(browser->QueryActiveShellView(&view)) || FAILED(view->GetItemObject(SVGIO_BACKGROUND,IID_PPV_ARGS(&background))) ||
       FAILED(background.As(&folder)) || FAILED(folder->get_Application(&application)) || FAILED(application.As(&shell))) return E_FAIL;
    wchar_t system[32768];
    UINT length=GetSystemDirectoryW(system,32768);
    if(!length || length>=32768) return E_FAIL;
    std::wstring powershell=std::wstring(system)+L"\\WindowsPowerShell\\v1.0\\powershell.exe";
    std::wstring parameters=L"-NoLogo -NoProfile -ExecutionPolicy Bypass -File \""+std::wstring(script)+L"\"";
    ShellValue executable(powershell.c_str()), arguments(parameters.c_str()), directory(L""), operation(L"open");
#ifdef QUARTERDECK_ADMISSION_TEST
    ShellValue show(SW_HIDE);
#else
    ShellValue show(SW_SHOWNORMAL);
#endif
    if(!executable.value.bstrVal || !arguments.value.bstrVal || !directory.value.bstrVal || !operation.value.bstrVal) return E_OUTOFMEMORY;
    // Explorer owns the new process outside the application's non-breakaway job.
    // Never set BREAKAWAY_OK on that job: Chromium/crashpad must remain covered.
    return shell->ShellExecute(executable.value.bstrVal,arguments.value,directory.value,operation.value,show.value);
}

extern "C" int quarterdeck_update_window(const wchar_t *script) {
    if(!script || wcspbrk(script,L"\"\r\n") || !quarterdeck_safe_ancestors(script,1)) return 73;
    const wchar_t *name=wcsrchr(script,L'\\');
    if(!name || wcscmp(name+1,L"Update.ps1")) return 73;
    HANDLE file=CreateFileW(script,GENERIC_READ|READ_CONTROL,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
    BY_HANDLE_FILE_INFORMATION info;
    bool valid=file!=INVALID_HANDLE_VALUE && GetFileInformationByHandle(file,&info) && info.nNumberOfLinks==1 &&
        !(info.dwFileAttributes&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT)) &&
        info.nFileSizeHigh==0 && info.nFileSizeLow<=16384 && quarterdeck_private_handle(file);
    if(file!=INVALID_HANDLE_VALUE) CloseHandle(file);
    if(!valid || FAILED(CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED))) return 73;
    HRESULT result=open_from_desktop(script);
    CoUninitialize();
    return SUCCEEDED(result)?0:73;
}
