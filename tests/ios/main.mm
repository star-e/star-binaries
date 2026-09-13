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
        // Persist the result before exiting: simctl console output is not an acknowledgement.
        const char* token = std::getenv("STAR_SMOKE_TOKEN");
        if (token && *token) {
            NSString* documents = NSSearchPathForDirectoriesInDomains(
                NSDocumentDirectory, NSUserDomainMask, YES).firstObject;
            NSString* path = [documents stringByAppendingPathComponent:@"star-smoke-result.txt"];
            NSString* report = [NSString stringWithFormat:@"%s %s\n", token,
                result == 0 ? "STAR_IOS_SMOKE_PASSED" : "STAR_IOS_SMOKE_FAILED"];
            NSError* error = nil;
            if (![report writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:&error]) {
                NSLog(@"Cannot write smoke result: %@", error);
                std::exit(EXIT_FAILURE);
            }
            // Let simctl finish acknowledging launch. The runner reads the result
            // and terminates this process, including when the test failed.
            return;
        }
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