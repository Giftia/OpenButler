#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
#include <dxgi.h>
#include <dwmapi.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <atomic>
#include <chrono>
#include <fstream>
#include <iostream>
#include <thread>
#include <vector>
#include <memory>
#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <wtsapi32.h>
#include <fcntl.h>
#include <io.h>
using namespace winrt;
using namespace winrt::Windows::Graphics::Capture;
using namespace winrt::Windows::Graphics::DirectX;
using namespace winrt::Windows::Graphics::DirectX::Direct3D11;
constexpr wchar_t marker[] = L"OpenButlerSyntheticSource";
constexpr uintptr_t nonce = 0x4f425447;
struct WipeVector {std::vector<unsigned char>& bytes;~WipeVector(){if(!bytes.empty())SecureZeroMemory(bytes.data(),bytes.size());}};
struct Identity {
  HWND hwnd{}; DWORD pid{}; unsigned long long process_start{};
  std::wstring process_name, class_name, title; RECT bounds{};
  bool operator==(Identity const& b) const {
    return hwnd==b.hwnd && pid==b.pid && process_start==b.process_start
      && process_name==b.process_name && class_name==b.class_name && title==b.title
      && bounds.left==b.bounds.left && bounds.top==b.bounds.top
      && bounds.right==b.bounds.right && bounds.bottom==b.bounds.bottom;
  }
};
Identity identity(HWND w) {
  Identity i;i.hwnd=w;GetWindowThreadProcessId(w,&i.pid);
  HANDLE p=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,i.pid);
  if(!p) throw std::runtime_error("process_identity_unavailable");
  FILETIME created{},exit{},kernel{},user{};wchar_t executable[32768]{};DWORD length=32768;
  bool ok=GetProcessTimes(p,&created,&exit,&kernel,&user)
    && QueryFullProcessImageNameW(p,0,executable,&length);CloseHandle(p);
  if(!ok) throw std::runtime_error("process_identity_unavailable");
  i.process_start=(static_cast<unsigned long long>(created.dwHighDateTime)<<32)|created.dwLowDateTime;
  i.process_name=executable;auto sep=i.process_name.find_last_of(L"\\");
  if(sep!=std::wstring::npos)i.process_name=i.process_name.substr(sep+1);
  wchar_t title[1024]{},cls[256]{};
  if(GetWindowTextLengthW(w)>=1023 || !GetWindowTextW(w,title,1024) || !GetClassNameW(w,cls,256)
    || FAILED(DwmGetWindowAttribute(w,DWMWA_EXTENDED_FRAME_BOUNDS,&i.bounds,sizeof(i.bounds))))
    throw std::runtime_error("window_identity_unavailable");
  i.title=title;i.class_name=cls;return i;
}
bool unlocked() {
  HDESK d = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
  if (!d) return false;
  wchar_t name[128]{}; DWORD needed{};
  bool ok = GetUserObjectInformationW(d, UOI_NAME, name, sizeof(name), &needed)
    && wcscmp(name, L"Default") == 0;
  CloseDesktop(d); return ok;
}
// Prototype deliberately accepts only its own generated public fixture window.
bool valid(HWND w) {
  DWORD pid{}; GetWindowThreadProcessId(w, &pid);
  return IsWindow(w) && IsWindowVisible(w) && !IsIconic(w)
    && pid == GetCurrentProcessId()
    && reinterpret_cast<uintptr_t>(GetPropW(w, marker)) == nonce && unlocked();
}
LRESULT CALLBACK proc(HWND w, UINT m, WPARAM a, LPARAM b) {
  // Internal synthetic-fixture commands; no input injection or user window control.
  if(m==WM_APP+1){
    if(a==1)SetWindowTextW(w,L"OpenButler changed public fixture");
    if(a==2)SetWindowPos(w,nullptr,200,200,0,0,SWP_NOSIZE|SWP_NOZORDER);
    if(a==3)SetWindowPos(w,nullptr,0,0,900,600,SWP_NOMOVE|SWP_NOZORDER);
    if(a==4)DestroyWindow(w);
    if(a==5){SetWindowTextW(w,L"transient public fixture");SetWindowTextW(w,L"OpenButler public synthetic integration");}
    return 0;
  }
  if (m == WM_PAINT) { PAINTSTRUCT ps{}; HDC dc=BeginPaint(w,&ps);
    RECT r{}; GetClientRect(w,&r); HBRUSH brush=CreateSolidBrush(RGB(240,250,255));
    FillRect(dc,&r,brush); DeleteObject(brush); SetTextColor(dc,RGB(0,40,90));
    DrawTextW(dc,L"OPENBUTLER PUBLIC SYNTHETIC TEST\nShopping: apples, milk\nNo private data. Source-bound capture only.",-1,&r,DT_LEFT|DT_TOP);
    EndPaint(w,&ps); return 0; }
  return DefWindowProcW(w,m,a,b);
}
void pump() { MSG m; while(PeekMessageW(&m,nullptr,0,0,PM_REMOVE)){TranslateMessage(&m);DispatchMessageW(&m);} }
void capture(HWND w, const char* output, std::string test="", Identity const* external=nullptr, std::atomic<bool>* revoked=nullptr, std::vector<unsigned char>* raw=nullptr, unsigned long long* timestamp=nullptr) {
  if (external ? (!IsWindow(w) || !IsWindowVisible(w) || IsIconic(w) || !unlocked()) : !valid(w)) throw std::runtime_error("source_identity_or_desktop_invalid");
  Identity bound=external?*external:identity(w);
  if(test=="pid_reuse") bound.process_start++;
  auto authorized=[&](){return test!="locked" && test!="lock_unknown" && (!revoked || !*revoked)
      && (external?(IsWindow(w)&&IsWindowVisible(w)&&!IsIconic(w)&&unlocked()):valid(w)) && identity(w)==bound;};
  if(!authorized()) throw std::runtime_error("source_revoked");
  auto interop=get_activation_factory<GraphicsCaptureItem,IGraphicsCaptureItemInterop>();
  std::cerr<<"stage:create_item\n";
  GraphicsCaptureItem item{nullptr};
  check_hresult(interop->CreateForWindow(w,guid_of<GraphicsCaptureItem>(),put_abi(item)));
  auto closed=std::make_shared<std::atomic<bool>>(false);
  auto token=item.Closed([closed](auto const&,auto const&){*closed=true;});
  com_ptr<ID3D11Device> device; com_ptr<ID3D11DeviceContext> ctx;
  std::cerr<<"stage:create_device\n";
  check_hresult(D3D11CreateDevice(nullptr,D3D_DRIVER_TYPE_HARDWARE,nullptr,D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    nullptr,0,D3D11_SDK_VERSION,device.put(),nullptr,ctx.put()));
  auto dxgi=device.as<IDXGIDevice>(); com_ptr<IInspectable> inspect;
  check_hresult(CreateDirect3D11DeviceFromDXGIDevice(dxgi.get(),inspect.put()));
  auto size=item.Size();
  if(size.Width<=0 || size.Height<=0) throw std::runtime_error("invalid_initial_dimensions");
  std::cerr<<"stage:create_pool "<<size.Width<<"x"<<size.Height<<"\n";
  auto pool=Direct3D11CaptureFramePool::CreateFreeThreaded(inspect.as<IDirect3DDevice>(),DirectXPixelFormat::B8G8R8A8UIntNormalized,1,size);
  auto session=pool.CreateCaptureSession(item);
  struct Cleanup { GraphicsCaptureSession& s; Direct3D11CaptureFramePool& p; ~Cleanup(){try{s.Close();p.Close();}catch(...){}} } cleanup{session,pool};
  session.IsCursorCaptureEnabled(false); session.StartCapture();
  if(test=="title")SetWindowTextW(w,L"changed title must revoke");
  if(test=="geometry")SetWindowPos(w,nullptr,200,200,0,0,SWP_NOSIZE|SWP_NOZORDER);
  if(test=="resize")SetWindowPos(w,nullptr,0,0,800,500,SWP_NOMOVE|SWP_NOZORDER);
  if(test=="close")DestroyWindow(w);
  if(test=="hwnd_reuse")RemovePropW(w,marker);
  std::cerr<<"stage:acquire\n";
  Direct3D11CaptureFrame frame{nullptr};
  auto deadline=std::chrono::steady_clock::now()+(test=="timeout"?std::chrono::milliseconds(100):std::chrono::milliseconds(3000));
  while(!frame) {
    pump(); if(*closed || !authorized()) throw std::runtime_error("source_revoked");
    if(std::chrono::steady_clock::now()>=deadline) throw std::runtime_error("frame_timeout");
    if(test!="timeout")frame=pool.TryGetNextFrame(); std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  auto content=frame.ContentSize();
  FILETIME wall{};GetSystemTimePreciseAsFileTime(&wall);LARGE_INTEGER qpc{},frequency{};
  QueryPerformanceCounter(&qpc);QueryPerformanceFrequency(&frequency);
  auto systemTime=frame.SystemRelativeTime();if(systemTime.count()<=0)throw std::runtime_error("frame_timestamp_missing");
  long long nowQpc100ns=static_cast<long long>((static_cast<long double>(qpc.QuadPart)*10000000)/frequency.QuadPart);
  long long age100ns=nowQpc100ns-systemTime.count();
  if(age100ns<0 || age100ns>80000000)throw std::runtime_error("frame_timestamp_invalid");
  unsigned long long wall100ns=(static_cast<unsigned long long>(wall.dwHighDateTime)<<32)|wall.dwLowDateTime;
  auto capturedMs=(wall100ns-116444736000000000ULL-static_cast<unsigned long long>(age100ns))/10000;
  std::cerr<<"stage:copy\n";
  if(content.Width!=size.Width || content.Height!=size.Height || content.Width<=0 || content.Height<=0
    || content.Width>4096 || content.Height>4096) throw std::runtime_error("resize_or_dimensions_invalid");
  auto access=frame.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>(); com_ptr<ID3D11Texture2D> texture;
  check_hresult(access->GetInterface(__uuidof(ID3D11Texture2D),texture.put_void()));
  D3D11_TEXTURE2D_DESC desc{}; texture->GetDesc(&desc);
  if(UINT(content.Width)>desc.Width || UINT(content.Height)>desc.Height) throw std::runtime_error("content_outside_surface");
  desc.Width=content.Width; desc.Height=content.Height; desc.Usage=D3D11_USAGE_STAGING;
  desc.BindFlags=0;desc.CPUAccessFlags=D3D11_CPU_ACCESS_READ;desc.MiscFlags=0;
  com_ptr<ID3D11Texture2D> staging;check_hresult(device->CreateTexture2D(&desc,nullptr,staging.put()));
  D3D11_BOX box{0,0,0,UINT(content.Width),UINT(content.Height),1};
  ctx->CopySubresourceRegion(staging.get(),0,0,0,0,texture.get(),0,&box);
  D3D11_MAPPED_SUBRESOURCE mapped{};check_hresult(ctx->Map(staging.get(),0,D3D11_MAP_READ,0,&mapped));
  std::vector<unsigned char> pixels(size_t(content.Width)*content.Height*4);
  WipeVector wipePixels{pixels};
  for(int y=0;y<content.Height;y++) memcpy(pixels.data()+size_t(y)*content.Width*4,static_cast<unsigned char*>(mapped.pData)+size_t(y)*mapped.RowPitch,size_t(content.Width)*4);
  // WGC can return transparent rounded corners. Never publish their RGB bytes.
  for(size_t offset=0;offset<pixels.size();offset+=4)if(pixels[offset+3]!=255){pixels[offset]=pixels[offset+1]=pixels[offset+2]=0;pixels[offset+3]=255;}
  ctx->Unmap(staging.get(),0);frame.Close();session.Close();pool.Close();item.Closed(token);
  if(*closed || !authorized()) throw std::runtime_error("source_revoked_before_publish");
  BITMAPFILEHEADER fh{};BITMAPINFOHEADER ih{};ih.biSize=sizeof(ih);ih.biWidth=content.Width;ih.biHeight=-content.Height;
  ih.biPlanes=1;ih.biBitCount=32;ih.biSizeImage=DWORD(pixels.size());fh.bfType=0x4d42;fh.bfOffBits=sizeof(fh)+sizeof(ih);fh.bfSize=fh.bfOffBits+ih.biSizeImage;
  if(raw){raw->resize(fh.bfSize);memcpy(raw->data(),&fh,sizeof(fh));memcpy(raw->data()+sizeof(fh),&ih,sizeof(ih));memcpy(raw->data()+fh.bfOffBits,pixels.data(),pixels.size());SecureZeroMemory(pixels.data(),pixels.size());*timestamp=capturedMs;return;}
  std::ofstream file(output,std::ios::binary);file.write(reinterpret_cast<char*>(&fh),sizeof(fh));file.write(reinterpret_cast<char*>(&ih),sizeof(ih));file.write(reinterpret_cast<char*>(pixels.data()),pixels.size());
  SecureZeroMemory(pixels.data(),pixels.size());if(!file) throw std::runtime_error("output_failed");
  std::cout<<"{\"status\":\"captured\",\"capture_method\":\"windows-wgc-createforwindow\",\"captured_at_ms\":"<<capturedMs
    <<",\"width\":"<<content.Width<<",\"height\":"<<content.Height<<",\"dpi\":"<<GetDpiForWindow(w)
    <<",\"source_verified_before\":true,\"source_verified_after\":true,\"source_identity\":{\"window_id\":\"hwnd:"
    <<reinterpret_cast<uintptr_t>(w)<<"\",\"owner_pid\":"<<bound.pid<<",\"owner_process_start\":\""<<bound.process_start
    <<"\",\"owner_process_name\":\"capture.exe\",\"wm_class\":\"OpenButlerPublicFixture\",\"window_title\":\"OpenButler public synthetic capture test\",\"content_bounds\":{\"x\":"
    <<bound.bounds.left<<",\"y\":"<<bound.bounds.top<<",\"width\":"<<bound.bounds.right-bound.bounds.left<<",\"height\":"<<bound.bounds.bottom-bound.bounds.top<<"}}}\n";
}
int prototypeMain(int argc,char**argv) {try{
  init_apartment(apartment_type::multi_threaded);
  bool support=GraphicsCaptureSession::IsSupported();
  if(argc==1){std::cout<<"{\"wgc_supported\":"<<(support?"true":"false")<<",\"desktop_unlocked\":"<<(unlocked()?"true":"false")<<"}\n";return 0;}
  if(argc!=3 || std::string(argv[1])!="--self-test") throw std::runtime_error("only_self_test_allowed");
  if(!support || !unlocked()) throw std::runtime_error("capture_unavailable");
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  WNDCLASSW wc{};wc.lpfnWndProc=proc;wc.hInstance=GetModuleHandleW(nullptr);wc.lpszClassName=L"OpenButlerPublicFixture";RegisterClassW(&wc);
  HWND w=CreateWindowW(wc.lpszClassName,L"OpenButler public synthetic capture test",WS_OVERLAPPEDWINDOW,100,100,640,400,nullptr,nullptr,wc.hInstance,nullptr);
  SetPropW(w,marker,reinterpret_cast<HANDLE>(nonce));ShowWindow(w,SW_SHOW);UpdateWindow(w);
  for(int i=0;i<50;i++){pump();std::this_thread::sleep_for(std::chrono::milliseconds(10));}
  if(valid(nullptr)) throw std::runtime_error("invalid_handle_accepted");
  RemovePropW(w,marker);if(valid(w)) throw std::runtime_error("changed_identity_accepted");SetPropW(w,marker,reinterpret_cast<HANDLE>(nonce));
  capture(w,argv[2]);DestroyWindow(w);if(valid(w)) throw std::runtime_error("closed_window_accepted");
  for(auto test:{"title","geometry","resize","close","pid_reuse","hwnd_reuse","locked","lock_unknown","timeout"}) {
    HWND target=CreateWindowW(wc.lpszClassName,L"OpenButler synthetic rejection fixture",WS_OVERLAPPEDWINDOW,100,100,640,400,nullptr,nullptr,wc.hInstance,nullptr);
    SetPropW(target,marker,reinterpret_cast<HANDLE>(nonce));ShowWindow(target,SW_SHOW);UpdateWindow(target);
    for(int j=0;j<30;j++){pump();std::this_thread::sleep_for(std::chrono::milliseconds(10));}
    bool rejected=false;std::string reason;
    try{capture(target,"unexpected-output.bmp",test);}catch(std::runtime_error const&e){rejected=true;reason=e.what();}
    if(IsWindow(target))DestroyWindow(target);
    if(!rejected)throw std::runtime_error("negative_test_not_rejected");
    std::cout<<"{\"case\":\""<<test<<"\",\"status\":\"rejected\",\"reason\":\""<<reason<<"\"}\n";
  }
  std::cout<<"{\"identity_negative_tests\":\"passed\",\"closed_window\":\"rejected\"}\n";return 0;
}catch(hresult_error const&e){std::cerr<<"HRESULT "<<std::hex<<unsigned(e.code())<<" "<<to_string(e.message())<<"\n";return 2;}catch(std::exception const&e){std::cerr<<e.what()<<"\n";return 1;}}

// The provider never enumerates thumbnails or reads a monitor drawable.
using namespace winrt::Windows::Data::Json;
JsonObject jsonIdentity(Identity const&i) {
  JsonObject value,bounds;
  value.Insert(L"window_id",JsonValue::CreateStringValue(L"hwnd:"+std::to_wstring(reinterpret_cast<uintptr_t>(i.hwnd))));
  value.Insert(L"owner_pid",JsonValue::CreateNumberValue(i.pid));
  value.Insert(L"owner_process_start",JsonValue::CreateStringValue(std::to_wstring(i.process_start)));
  value.Insert(L"owner_process_name",JsonValue::CreateStringValue(i.process_name));
  value.Insert(L"wm_class",JsonValue::CreateStringValue(i.class_name));
  value.Insert(L"window_title",JsonValue::CreateStringValue(i.title));
  bounds.Insert(L"x",JsonValue::CreateNumberValue(i.bounds.left));bounds.Insert(L"y",JsonValue::CreateNumberValue(i.bounds.top));
  bounds.Insert(L"width",JsonValue::CreateNumberValue(i.bounds.right-i.bounds.left));bounds.Insert(L"height",JsonValue::CreateNumberValue(i.bounds.bottom-i.bounds.top));
  value.Insert(L"content_bounds",bounds);return value;
}
bool eligible(HWND w) {
  if(!IsWindow(w)||!IsWindowVisible(w)||IsIconic(w))return false;
  BOOL cloaked{};if(FAILED(DwmGetWindowAttribute(w,DWMWA_CLOAKED,&cloaked,sizeof(cloaked)))||cloaked)return false;
  LONG_PTR ex=GetWindowLongPtrW(w,GWL_EXSTYLE);
  if(ex&(WS_EX_LAYERED|WS_EX_TRANSPARENT))return false;
  try{auto i=identity(w);return i.pid && i.process_start && !i.process_name.empty()
    && i.process_name.size()<=120 && !i.class_name.empty() && i.class_name.size()<=240
    && !i.title.empty() && i.title.size()<=240 && i.bounds.left>=0 && i.bounds.top>=0
    && i.bounds.right>i.bounds.left && i.bounds.bottom>i.bounds.top
    && i.bounds.right-i.bounds.left<=4096 && i.bounds.bottom-i.bounds.top<=4096
    && static_cast<long long>(i.bounds.right-i.bounds.left)*(i.bounds.bottom-i.bounds.top)<=2000000;}catch(...){return false;}
}
std::atomic<HWND> selected{nullptr};std::atomic<bool> sourceRevoked{true},stopping{false};
std::atomic<bool> watchReady{false};Identity boundIdentity;
void CALLBACK eventHook(HWINEVENTHOOK,DWORD event,HWND w,LONG object,LONG child,DWORD,DWORD) {
  if(w==selected && object==OBJID_WINDOW && child==CHILDID_SELF
    && (event==EVENT_OBJECT_DESTROY||event==EVENT_OBJECT_HIDE||event==EVENT_OBJECT_NAMECHANGE||event==EVENT_OBJECT_LOCATIONCHANGE)) sourceRevoked=true;
}
LRESULT CALLBACK guardProc(HWND w,UINT m,WPARAM a,LPARAM b) {
  if(m==WM_WTSSESSION_CHANGE && (a==WTS_SESSION_LOCK||a==WTS_SESSION_LOGOFF||a==WTS_CONSOLE_DISCONNECT||a==WTS_REMOTE_DISCONNECT))sourceRevoked=true;
  if(m==WM_POWERBROADCAST && a==PBT_APMSUSPEND)sourceRevoked=true;
  return DefWindowProcW(w,m,a,b);
}
void watch() {
  WNDCLASSW wc{};wc.lpfnWndProc=guardProc;wc.hInstance=GetModuleHandleW(nullptr);wc.lpszClassName=L"OpenButlerSourceGuard";RegisterClassW(&wc);
  HWND notification=CreateWindowW(wc.lpszClassName,L"",0,0,0,0,0,nullptr,nullptr,wc.hInstance,nullptr);
  HWINEVENTHOOK hook=SetWinEventHook(EVENT_OBJECT_DESTROY,EVENT_OBJECT_NAMECHANGE,nullptr,eventHook,0,0,WINEVENT_OUTOFCONTEXT);
  bool registered=notification&&WTSRegisterSessionNotification(notification,NOTIFY_FOR_THIS_SESSION);
  watchReady=hook&&registered;
  while(!stopping){pump();if(selected && (!unlocked()||!IsWindow(selected)))sourceRevoked=true;std::this_thread::sleep_for(std::chrono::milliseconds(10));}
  if(hook)UnhookWinEvent(hook);if(registered)WTSUnRegisterSessionNotification(notification);if(notification)DestroyWindow(notification);
}
void requireSource() {
  if(!selected || sourceRevoked || !watchReady || !unlocked() || !eligible(selected)
    || !(identity(selected)==boundIdentity)) {sourceRevoked=true;throw std::runtime_error("window_source_revoked");}
}
JsonObject ok() {JsonObject r;r.Insert(L"ok",JsonValue::CreateBooleanValue(true));return r;}
void respond(JsonObject const&r,std::vector<unsigned char>*bytes=nullptr) {
  std::string header=to_string(r.Stringify());std::cout<<header<<"\n";
  if(bytes&&!bytes->empty()){std::cout.write(reinterpret_cast<char*>(bytes->data()),bytes->size());SecureZeroMemory(bytes->data(),bytes->size());}
  std::cout.flush();
}
int providerMain() {
  init_apartment(apartment_type::multi_threaded);SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  _setmode(_fileno(stdout),_O_BINARY);std::thread monitor(watch);
  for(int i=0;i<100&&!watchReady;i++)std::this_thread::sleep_for(std::chrono::milliseconds(10));
  std::string line;
  while(std::getline(std::cin,line)) {
    try {
      if(line.size()>100000)throw std::runtime_error("source_protocol_failed");
      auto command=JsonObject::Parse(to_hstring(line));auto action=command.GetNamedString(L"action");auto r=ok();
      if(action==L"probe") {r.Insert(L"supported",JsonValue::CreateBooleanValue(GraphicsCaptureSession::IsSupported()&&watchReady&&unlocked()));respond(r);continue;}
      if(!GraphicsCaptureSession::IsSupported()||!watchReady||!unlocked())throw std::runtime_error("capture_unavailable");
      if(action==L"list") {
        JsonArray sources;EnumWindows([](HWND w,LPARAM data)->BOOL{if(eligible(w)){try{reinterpret_cast<JsonArray*>(data)->Append(jsonIdentity(identity(w)));}catch(...){}}return TRUE;},reinterpret_cast<LPARAM>(&sources));
        r.Insert(L"sources",sources);respond(r);continue;
      }
      if(action==L"bind") {
        selected=nullptr;sourceRevoked=true;
        auto expected=command.GetNamedObject(L"source_identity");auto id=to_string(expected.GetNamedString(L"window_id"));
        if(id.rfind("hwnd:",0)!=0 || id.size()>25 || id.size()<6
          || id.substr(5).find_first_not_of("0123456789")!=std::string::npos)throw std::runtime_error("invalid_window_identity");
        auto number=std::stoull(id.substr(5));if(!number)throw std::runtime_error("invalid_window_identity");
        HWND w=reinterpret_cast<HWND>(static_cast<uintptr_t>(number));
        if(!eligible(w))throw std::runtime_error("window_source_unavailable");
        auto actual=identity(w);auto actualJson=jsonIdentity(actual);
        if(expected.Size()!=7 || expected.GetNamedObject(L"content_bounds").Size()!=4)throw std::runtime_error("invalid_window_identity");
        for(auto const&entry:actualJson)if(!expected.HasKey(entry.Key())||expected.GetNamedValue(entry.Key()).Stringify()!=entry.Value().Stringify())throw std::runtime_error("source_binding_mismatch");
        boundIdentity=actual;selected=w;sourceRevoked=false;requireSource();respond(r);continue;
      }
      requireSource();
      if(action==L"prepare") {respond(r);continue;}
      if(action==L"inspect") {
        HWND foreground=GetForegroundWindow();if(!foreground||!eligible(foreground))throw std::runtime_error("application_excluded_or_unknown");
        r.Insert(L"source_identity",jsonIdentity(boundIdentity));r.Insert(L"foreground_identity",jsonIdentity(identity(foreground)));
        r.Insert(L"lock_state",JsonValue::CreateStringValue(L"unlocked"));r.Insert(L"lock_protection_supported",JsonValue::CreateBooleanValue(true));respond(r);continue;
      }
      if(action==L"capture") {
        std::vector<unsigned char> bytes;WipeVector wipeBytes{bytes};unsigned long long stamp{};
        capture(selected,nullptr,"",&boundIdentity,&sourceRevoked,&bytes,&stamp);
        try{requireSource();}catch(...){SecureZeroMemory(bytes.data(),bytes.size());throw;}
        r.Insert(L"raw_bytes",JsonValue::CreateNumberValue(bytes.size()));r.Insert(L"pixel_encoding",JsonValue::CreateStringValue(L"bmp-bgra32"));
        r.Insert(L"source_identity",jsonIdentity(boundIdentity));r.Insert(L"captured_at_ms",JsonValue::CreateNumberValue(static_cast<double>(stamp)));
        r.Insert(L"capture_method",JsonValue::CreateStringValue(L"windows_wgc_hwnd"));r.Insert(L"source_verified_before",JsonValue::CreateBooleanValue(true));r.Insert(L"source_verified_after",JsonValue::CreateBooleanValue(true));
        respond(r,&bytes);continue;
      }
      throw std::runtime_error("source_protocol_failed");
    }catch(...){sourceRevoked=true;auto r=ok();r.Insert(L"ok",JsonValue::CreateBooleanValue(false));r.Insert(L"error",JsonValue::CreateStringValue(L"window_source_unavailable"));respond(r);}
  }
  stopping=true;monitor.join();return 0;
}
int fixtureMain() {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  WNDCLASSW wc{};wc.lpfnWndProc=proc;wc.hInstance=GetModuleHandleW(nullptr);wc.lpszClassName=L"OpenButlerPublicFixture";RegisterClassW(&wc);
  HWND w=CreateWindowW(wc.lpszClassName,L"OpenButler public synthetic integration",WS_OVERLAPPEDWINDOW,100,100,800,500,nullptr,nullptr,wc.hInstance,nullptr);
  ShowWindow(w,SW_SHOW);UpdateWindow(w);SetForegroundWindow(w);
  std::thread input([w](){std::string command;while(std::getline(std::cin,command)){
    WPARAM action=command=="title"?1:command=="move"?2:command=="resize"?3:command=="close"?4:command=="title_roundtrip"?5:0;
    if(action)PostMessageW(w,WM_APP+1,action,0);
  }});input.detach();
  auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(120);
  while(IsWindow(w)&&std::chrono::steady_clock::now()<deadline){pump();std::this_thread::sleep_for(std::chrono::milliseconds(10));}
  if(IsWindow(w))DestroyWindow(w);return 0;
}
int main(int argc,char**argv){if(argc==2&&std::string(argv[1])=="--provider")return providerMain();if(argc==2&&std::string(argv[1])=="--fixture")return fixtureMain();return prototypeMain(argc,argv);}
