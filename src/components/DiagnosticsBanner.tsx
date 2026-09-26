import { useEffect, useState } from 'react';
import {
  buildDiagnostics,
  dismissQuarantineRecords,
  getQuarantineRecords,
  type QuarantineRecord,
} from '../persist';

const REASON_LABELS: Record<QuarantineRecord['reason'], string> = {
  'parse-error': '内容不是合法 JSON',
  'validation-error': '结构不符合当前版本',
  'unknown-version': '版本高于当前应用',
  'migration-error': '版本迁移失败',
};

/**
 * 本地数据隔离提示条：启动加载发现损坏 / 未知版本数据时展示。
 * 数据已隔离、应用已回退默认值，不阻塞使用；可下载诊断 JSON 或忽略并清除。
 */
export function DiagnosticsBanner() {
  const [records, setRecords] = useState<QuarantineRecord[]>([]);

  // 各面板的加载（含隔离）都在渲染阶段完成，挂载副作用里能拿到本次启动的全部记录
  useEffect(() => {
    const found = getQuarantineRecords();
    if (found.length > 0) setRecords(found);
  }, []);

  if (records.length === 0) return null;

  const download = () => {
    const blob = new Blob([buildDiagnostics()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'url-route-debugger-diagnostics.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const dismiss = () => {
    dismissQuarantineRecords();
    setRecords([]);
  };

  return (
    <div className="banner warn diagnostics-banner">
      <p>
        ⚠️ 检测到 {records.length} 份无法读取的本地数据，已隔离并回退到默认值（不影响使用）：
        {records.map((r) => (
          <span className="diag-item" key={`${r.key}:${r.at}`}>
            <code>{r.key}</code>（{REASON_LABELS[r.reason]}）
          </span>
        ))}
      </p>
      <div className="diag-actions">
        <button onClick={download}>下载诊断 JSON</button>
        <button className="danger" onClick={dismiss}>
          忽略并清除
        </button>
      </div>
    </div>
  );
}
