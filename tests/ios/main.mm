#import <UIKit/UIKit.h>
#import <dispatch/dispatch.h>

#include <cstdlib>
#include <iostream>

int star_zlib_roundtrip();

@interface StarSmokeDelegate : UIResponder <UIApplicationDelegate>
@property(nonatomic, strong) UIWindow* window;
@end

@implementation StarSmokeDelegate
- (BOOL)application:(UIApplication*)application
    didFinishLaunchingWithOptions:(NSDictionary*)launchOptions {
    self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
    self.window.rootViewController = [[UIViewController alloc] init];
    [self.window makeKeyAndVisible];
    dispatch_async(dispatch_get_main_queue(), ^{
        const int result = star_zlib_roundtrip();
        std::cout << (result == 0 ? "STAR_IOS_SMOKE_PASSED" : "STAR_IOS_SMOKE_FAILED")
                  << std::endl;
        std::exit(result);
    });
    return YES;
}
@end

int main(int argc, char* argv[]) {
    @autoreleasepool {
        return UIApplicationMain(argc, argv, nil, NSStringFromClass(StarSmokeDelegate.class));
    }
}