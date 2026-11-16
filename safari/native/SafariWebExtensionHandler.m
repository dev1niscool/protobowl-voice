// ProtoBowl Voice does not use native messaging or collect profile information.
#import "SafariWebExtensionHandler.h"

@implementation SafariWebExtensionHandler
- (void)beginRequestWithExtensionContext:(NSExtensionContext *)context {
    [context completeRequestReturningItems:@[] completionHandler:nil];
}
@end
