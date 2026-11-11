#import <Cocoa/Cocoa.h>
#include <stdio.h>

// 只提供 Dock 身份与窗口激活信号，插件仍由宿主管理，不执行插件代码。
@interface DockDelegate : NSObject <NSApplicationDelegate>
@end
@implementation DockDelegate
- (BOOL)applicationShouldHandleReopen:(NSApplication *)application hasVisibleWindows:(BOOL)visible {
    puts("focus"); fflush(stdout);
    return NO;
}
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
    puts("close"); fflush(stdout);
    return NSTerminateCancel;
}
@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 3) return 2;
        NSApplication *application = [NSApplication sharedApplication];
        DockDelegate *delegate = [DockDelegate new];
        application.delegate = delegate;
        NSImage *icon = [[NSImage alloc] initWithContentsOfFile:@(argv[1])];
        if (!icon || !icon.isValid) return 3;
        [application setApplicationIconImage:icon];
        [application setActivationPolicy:NSApplicationActivationPolicyRegular];
        NSMenu *menu = [NSMenu new];
        NSMenuItem *item = [NSMenuItem new];
        NSMenu *submenu = [NSMenu new];
        [submenu addItemWithTitle:[@"关闭 " stringByAppendingString:@(argv[2])] action:@selector(terminate:) keyEquivalent:@"q"];
        item.submenu = submenu; [menu addItem:item]; application.mainMenu = menu;
        // 管道断开即退出；宿主崩溃也不会留下悬空图标。不主动抢走插件焦点。
        dispatch_source_t input = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, STDIN_FILENO, 0, dispatch_get_main_queue());
        dispatch_source_set_event_handler(input, ^{
            char buffer[256];
            if (read(STDIN_FILENO, buffer, sizeof(buffer)) <= 0) exit(0);
        });
        dispatch_resume(input);
        puts("ready"); fflush(stdout);
        [application run];
    }
    return 0;
}
