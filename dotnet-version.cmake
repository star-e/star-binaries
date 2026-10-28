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
set(STAR_DOTNET_SDK_URL "https://builds.dotnet.microsoft.com/dotnet/Sdk/${STAR_DOTNET_SDK_VERSION}/dotnet-sdk-${STAR_DOTNET_SDK_VERSION}-win-x64.zip")
set(STAR_DOTNET_SDK_SHA512 "dae0a0450d92b5315034db134259acffe9ec0043d93dced4fb2a9b8700520e87a99005d6845ad80716f4a8f30df24ae5363ca7c9be391797b4f53170e9b2c088")
