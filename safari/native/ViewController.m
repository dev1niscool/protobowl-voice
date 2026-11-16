// ProtoBowl Voice
#import "ViewController.h"
#import <SafariServices/SafariServices.h>
#import <WebKit/WebKit.h>

@interface ViewController () <WKScriptMessageHandler>
@property (nonatomic) IBOutlet WKWebView *webView;
@end

@implementation ViewController
- (void)viewDidLoad {
    [super viewDidLoad];
    [self.webView.configuration.userContentController addScriptMessageHandler:self name:@"controller"];
    NSURL *page = [NSBundle.mainBundle URLForResource:@"Main" withExtension:@"html"];
    [self.webView loadFileURL:page allowingReadAccessToURL:NSBundle.mainBundle.resourceURL];
}

- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    if (![message.body isEqualToString:@"open-preferences"]) return;
    [SFSafariApplication showPreferencesForExtensionWithIdentifier:@"org.protobowl.voice.Extension"
        completionHandler:^(NSError *error) {}];
}
@end
