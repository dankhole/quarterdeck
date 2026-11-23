#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shlobj.h>
#include <shldisp.h>
#include <exdisp.h>
#include <servprov.h>
#include <wrl/client.h>
#include <cstdio>
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

static int update_failure(const char *stage, HRESULT result) {
    std::fprintf(stderr,"Quarterdeck update window: %s failed (HRESULT 0x%08lX).\n",stage,static_cast<unsigned long>(result));
    return 73;
}

static int open_from_desktop(const wchar_t *script) {
    ComPtr<IShellWindows> windows;
    HRESULT result=CoCreateInstance(CLSID_ShellWindows,nullptr,CLSCTX_LOCAL_SERVER,IID_PPV_ARGS(&windows));
    if(FAILED(result)) return update_failure("create ShellWindows",result);
    // For SWC_DESKTOP, Microsoft's FindDesktopFolderView example uses
    // VT_I4(CSIDL_DESKTOP) for the location and VT_EMPTY for the root. The
    // FindWindowSW reference describes the PIDL form for ordinary folders.
    // https://devblogs.microsoft.com/oldnewthing/20130318-00/?p=4933
    VARIANT empty; VariantInit(&empty);
    ShellValue desktop(CSIDL_DESKTOP);
    long window=0;
    ComPtr<IDispatch> dispatch;
    result=windows->FindWindowSW(&desktop.value,&empty,SWC_DESKTOP,&window,SWFO_NEEDDISPATCH,&dispatch);
    if(result==S_FALSE && !dispatch) {
        std::fputs("Quarterdeck update window: Explorer desktop automation was not found "
            "(FindWindowSW returned S_FALSE, HRESULT 0x00000001); no worker launched.\n",stderr);
        return 73;
    }
    if(result!=S_OK) return update_failure("find desktop shell window",result);
    if(!dispatch) return update_failure("find desktop shell window",E_UNEXPECTED);
    ComPtr<IServiceProvider> provider;
    ComPtr<IShellBrowser> browser;
    ComPtr<IShellView> view;
    ComPtr<IDispatch> background;
    ComPtr<IShellFolderViewDual> folder;
    ComPtr<IDispatch> application;
    ComPtr<IShellDispatch2> shell;
    result=dispatch.As(&provider);
    if(FAILED(result)) return update_failure("query desktop service provider",result);
    result=provider->QueryService(SID_STopLevelBrowser,IID_PPV_ARGS(&browser));
    if(FAILED(result)) return update_failure("query desktop browser service",result);
    result=browser->QueryActiveShellView(&view);
    if(FAILED(result)) return update_failure("query desktop shell view",result);
    result=view->GetItemObject(SVGIO_BACKGROUND,IID_PPV_ARGS(&background));
    if(FAILED(result)) return update_failure("get desktop folder view dispatch",result);
    result=background.As(&folder);
    if(FAILED(result)) return update_failure("query desktop folder view",result);
    result=folder->get_Application(&application);
    if(FAILED(result) || !application) return update_failure("get desktop application dispatch",result);
    result=application.As(&shell);
    if(FAILED(result)) return update_failure("query Explorer broker",result);
    wchar_t system[32768];
    UINT length=GetSystemDirectoryW(system,32768);
    if(!length) return update_failure("get system directory",HRESULT_FROM_WIN32(GetLastError()));
    if(length>=32768) return update_failure("get system directory",HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER));
    std::wstring powershell=std::wstring(system)+L"\\WindowsPowerShell\\v1.0\\powershell.exe";
    std::wstring parameters=L"-NoLogo -NoProfile -ExecutionPolicy Bypass -File \""+std::wstring(script)+L"\"";
    ShellValue executable(powershell.c_str()), arguments(parameters.c_str()), directory(L""), operation(L"open");
#ifdef QUARTERDECK_ADMISSION_TEST
    ShellValue show(SW_HIDE);
#else
    ShellValue show(SW_SHOWNORMAL);
#endif
    if(!executable.value.bstrVal || !arguments.value.bstrVal || !directory.value.bstrVal || !operation.value.bstrVal)
        return update_failure("allocate worker arguments",E_OUTOFMEMORY);
    // Explorer owns the new process outside the application's non-breakaway job.
    // Never set BREAKAWAY_OK on that job: Chromium/crashpad must remain covered.
    result=shell->ShellExecute(executable.value.bstrVal,arguments.value,directory.value,operation.value,show.value);
    return result==S_OK ? 0 : update_failure("launch PowerShell from Explorer",result);
}

#ifdef QUARTERDECK_ADMISSION_TEST
#pragma comment(lib, "user32.lib")

static HRESULT probe_desktop_automation() {
    // Independent control: reproduce Microsoft's ATL example (whose default
    // activation context is CLSCTX_ALL), not the product lookup or launch path.
    ComPtr<IShellWindows> windows;
    HRESULT result=CoCreateInstance(CLSID_ShellWindows,nullptr,CLSCTX_ALL,IID_PPV_ARGS(&windows));
    if(FAILED(result)) return result;
    if(!windows) return E_UNEXPECTED;
    VARIANT location, root;
    VariantInit(&location);
    VariantInit(&root);
    location.vt=VT_I4;
    location.lVal=CSIDL_DESKTOP;
    long window=0;
    ComPtr<IDispatch> dispatch;
    result=windows->FindWindowSW(&location,&root,SWC_DESKTOP,&window,SWFO_NEEDDISPATCH,&dispatch);
    if((result==S_OK && !dispatch) || (result==S_FALSE && dispatch)) return E_UNEXPECTED;
    return result;
}

extern "C" int quarterdeck_test_explorer() {
    const char *shell=GetShellWindow() ? "present" : "absent";
    HRESULT initialized=CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED);
    if(FAILED(initialized)) return update_failure("initialize desktop probe",initialized);
    HRESULT result=probe_desktop_automation();
    CoUninitialize();
    if(result!=S_OK && result!=S_FALSE) return update_failure("probe desktop automation",result);
    std::printf("%s %s\n",shell,result==S_OK ? "registered" : "not-found");
    return 0;
}
#endif

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
    if(!valid) return 73;
    HRESULT initialized=CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED);
    if(FAILED(initialized)) return update_failure("initialize COM",initialized);
    int result=open_from_desktop(script);
    CoUninitialize();
    return result;
}
