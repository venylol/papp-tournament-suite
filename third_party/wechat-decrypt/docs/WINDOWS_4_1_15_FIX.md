# Windows 微信 4.1.15 数据库密钥提取修复

旧扫描器只搜索进程中的明文 `x'<hex>'` 密钥。微信 4.1.15.13 的
WCDB Config.Cipher 对象使用编码后的配置内容，因此会出现“0 hex 模式”。

本修复保留旧扫描器，并增加 Config.Cipher 对象定位、XOR 解码和逐库密钥验证。
只有通过所选数据库首页认证的标准 raw key 才保存为现有 all_keys.json 格式。
不使用微信 DLL 固定函数偏移，不注入进程，不启动或关闭微信。

另外补充 Windows x64 API 参数和返回类型声明、分块内存读取、实际读取量、
失败次数、配置对象数量和微信完整版本号诊断。需使用 64 位 Python。

## 验证

- 2026-10-01，在本机 Windows 微信 4.1.15.13 做只读验证：20/20 个数据库
  salt 对应密钥通过验证，读取失败 0 次，没有保存密钥或修改数据库。
- 6 项合成内存/认证页回归测试通过，覆盖编码对象、错误密钥、无效指针、
  分块边界、不可读区域和旧扫描器。
- 尚未在最初报错用户的机器验证；其他 4.1.15 小版本不能保证完全一致。

## 补丁使用

退出正在运行的解密脚本，保留原文件备份，将补丁里的 third_party 文件夹
合并到 PAPP-Offline 根目录。补丁只更新脚本和说明，不含 config.json、
all_keys.json、任何用户数据或 Python 依赖。

保持微信登录，用原来的 papp-wechat-decrypt.cmd 启动。此启动器使用随包
Python 运行 main.py，不需要更换 PAPP-Local-Frontend.exe。

如果仍失败，请提供版本、实际读取量、Config.Cipher 名称/引用/解码/验证数量；
不要发送密钥文件。对象已解码但验证数为零时，先核对 db_dir 是否属于当前账号。

## 来源与许可证

布局、XOR 材料及提取方法参考：
https://github.com/fanyuantaier/wechatauto-replica/blob/main/wechatauto/db.py

来源项目采用 Apache-2.0，完整许可见 ../WCDB_CIPHER_UPSTREAM_LICENSE.txt。
本地实现适配了现有每 salt 密钥格式，并加入分块读取与诊断；未引入该项目
的发送消息、界面自动化或其他运行时功能。
