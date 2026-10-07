#include <libplatform/libplatform.h>
#include <v8.h>
#include <cstdio>
#include <cstring>
#include <memory>

#if !defined(V8_COMPRESS_POINTERS) || !defined(V8_ENABLE_SANDBOX)
#error "The Star V8 SDK requires pointer compression and sandbox support"
#endif

int star_v8_smoke() {
  if (std::strcmp(v8::V8::GetVersion(), STAR_V8_EXPECTED_VERSION) != 0) {
    std::fprintf(stderr, "Unexpected V8 version: %s\n", v8::V8::GetVersion());
    return 1;
  }
  if (!v8::V8::InitializeICUDefaultLocation(nullptr)) return 1;
  auto platform = v8::platform::NewDefaultPlatform();
  v8::V8::InitializePlatform(platform.get());
  if (!v8::V8::Initialize()) return 1;
  std::unique_ptr<v8::ArrayBuffer::Allocator> allocator(
      v8::ArrayBuffer::Allocator::NewDefaultAllocator());
  v8::Isolate::CreateParams params;
  params.array_buffer_allocator = allocator.get();
  auto* isolate = v8::Isolate::New(params);
  int status = 1;
  {
    v8::Isolate::Scope isolate_scope(isolate);
    v8::HandleScope handles(isolate);
    auto context = v8::Context::New(isolate);
    v8::Context::Scope context_scope(context);
    v8::TryCatch catcher(isolate);
    // Exercise JS, ArrayBuffer and embedded ICU data, with no external blobs.
    auto source = v8::String::NewFromUtf8Literal(isolate,
        "(() => { const a = new Uint8Array([20, 22]); "
        "return a[0] + a[1] === 42 && "
        "new Intl.NumberFormat('en-US').format(1234) === '1,234'; })()");
    v8::Local<v8::Script> script;
    v8::Local<v8::Value> result;
    if (v8::Script::Compile(context, source).ToLocal(&script) &&
        script->Run(context).ToLocal(&result) && result->IsTrue()) status = 0;
    if (catcher.HasCaught()) {
      v8::String::Utf8Value error(isolate, catcher.Exception());
      std::fprintf(stderr, "%s\n", *error ? *error : "JavaScript exception");
    }
  }
  isolate->Dispose();
  v8::V8::Dispose();
  v8::V8::DisposePlatform();
  std::printf("V8 %s: %s\n", STAR_V8_EXPECTED_VERSION,
              status == 0 ? "STAR_V8_SMOKE_PASSED" : "STAR_V8_SMOKE_FAILED");
  return status;
}

#ifndef STAR_V8_IOS
int main() { return star_v8_smoke(); }
#endif
