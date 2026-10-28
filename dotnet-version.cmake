# Build the upstream release from an immutable source revision.
set(STAR_DOTNET_VERSION "11.0.0-rc.3.26522.148")
set(STAR_DOTNET_TAG "v${STAR_DOTNET_VERSION}")
set(STAR_DOTNET_REVISION "474ed963699fc29809015392738a15231aaae2de")
# Identify our unsigned source build separately from Microsoft's distribution.
set(STAR_DOTNET_VERSION_SUFFIX "star.rc3.26522.148")
set(STAR_DOTNET_RUNTIME_VERSION "11.0.0-${STAR_DOTNET_VERSION_SUFFIX}")
set(STAR_DOTNET_SUBSETS "clr+libs+host.native+packs.product")

# Consumer compiler only. Building runtime itself uses its global.json SDK.
set(STAR_DOTNET_SDK_VERSION "11.0.100-rc.3.26522.148")
# SHA-512 values from Microsoft's 11.0 release metadata, indexed by host RID.
set(STAR_DOTNET_SDK_win-x64_SHA512 "dae0a0450d92b5315034db134259acffe9ec0043d93dced4fb2a9b8700520e87a99005d6845ad80716f4a8f30df24ae5363ca7c9be391797b4f53170e9b2c088")
set(STAR_DOTNET_SDK_osx-arm64_SHA512 "b06e103402928762f377e54f88249b756fd09121b2b3d80d94652815ef49d5f2e47922fefc0555f954ad9b1a37ba88680896e06bc746b57910be5a342c1b274e")
