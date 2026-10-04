import type { Metadata } from "next";
import "./globals.css";
import DialogHost from "@/components/ui/Dialog";
import DisablePictureInPicture from "@/components/DisablePictureInPicture";

export const metadata: Metadata = {
  title: "LAZA CINEMA STUDIO · 无限影视画布",
  description: "基于 FLUX.2 与 MiniMax H3 的工业级影视无限生成画布",
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }, { url: "/favicon.ico" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-full dark" suppressHydrationWarning>
      <body
        className="h-full bg-[#08080a] text-[#ededed] antialiased overflow-hidden selection:bg-purple-500/30 selection:text-white"
        suppressHydrationWarning
      >
        {children}
        {/* 全局弹框宿主：项目里不再使用 window.alert / confirm / prompt */}
        <DialogHost />
        {/* 画中画全局关闭：视频到处都在动态创建，只能盯着 DOM 逐个关 */}
        <DisablePictureInPicture />
      </body>
    </html>
  );
}
