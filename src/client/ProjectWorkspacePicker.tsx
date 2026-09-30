import {useLayoutEffect} from 'react';
import type {PropsRuntime} from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';

/**
 * Project 已由窗口确定工作区；替换官方菜单插槽，并通过它公开的 anchorRef 隐藏入口。
 * 官方 0.2 ConversationContent/EmptyHero 把按钮写在插槽外，尚无按钮可见性选项。
 * 只适配这个按钮，不依赖生成的 CSS 类或语言文案，卸载时恢复原有内联样式。
 */
export function ProjectWorkspacePicker({anchorRef, open, onClose}: PropsRuntime<'conversation.hero.workspace'>) {
  useLayoutEffect(() => {
    const button = anchorRef?.current;
    if (!button) return;
    const display = button.style.getPropertyValue('display');
    const priority = button.style.getPropertyPriority('display');
    button.style.setProperty('display', 'none');
    return () => {
      if (display) button.style.setProperty('display', display, priority);
      else button.style.removeProperty('display');
    };
  }, [anchorRef]);
  // 项目状态加载完成时，旧菜单可能已被打开；同步清除官方 owner 的展开状态。
  useLayoutEffect(() => {if (open) onClose();}, [open, onClose]);
  return null;
}
