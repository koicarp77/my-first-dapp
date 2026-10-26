"use client";

import { useEffect, useState } from "react";
import { formatUnits, isAddress, parseUnits } from "viem";
import { useAccount, useBlockNumber, useReadContracts } from "wagmi";
import {
  useDeployedContractInfo,
  useScaffoldEventHistory,
  useScaffoldReadContract,
  useScaffoldWriteContract,
  useSelectedNetwork,
} from "~~/hooks/scaffold-eth";

// FKWToken.decimals() = 18，页面金额以"个"为单位，读写链上时换算成最小单位
const TOKEN_DECIMALS = 18;

// 与 Escrow.sol 中 enum Status { Created, Paid, Completed, Refunded, Disputed } 一一对应
const STATUS_TEXT = ["Created", "Paid", "Completed", "Refunded", "Disputed"];
const STATUS_BADGE = ["badge-info", "badge-warning", "badge-success", "badge-neutral", "badge-error"];

// OrderCreated 事件解析出来的参数（id/buyer/seller/token/amount/deadline）
type CreatedEvent = {
  args: { id: bigint; buyer: string; seller: string; token: string; amount: bigint; deadline: bigint };
};

// getOrder 返回的 Order 结构
type Order = {
  buyer: string;
  seller: string;
  token: string;
  amount: bigint;
  deadline: bigint;
  status: number;
  description: string;
};

const shortAddr = (addr?: string) => (addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "…");
const fmtDeadline = (ts: bigint) => new Date(Number(ts) * 1000).toLocaleString("zh-CN");

export default function EscrowPage() {
  const { address } = useAccount();
  const selectedNetwork = useSelectedNetwork();

  // 合约级信息：仲裁人
  const { data: arbiter } = useScaffoldReadContract({ contractName: "Escrow", functionName: "arbiter" });

  // 实验要求：用 OrderCreated 事件列订单 id。
  // POTOS 测试网的 eth_getLogs 一次最多扫 10 个区块，blocksBatchSize 必须设为 10，否则会漏单；
  // 从部署块扫到最新块需要近 2000 次串行请求，中途任何一次超时都会让分页停住，
  // 所以下面用链上 orderCount 兜底，保证事件没扫全时列表也完整。
  const { data: createdOrders } = useScaffoldEventHistory({
    contractName: "Escrow",
    eventName: "OrderCreated",
    blocksBatchSize: 10,
    watch: true,
  });

  // 兜底：链上订单总数（useScaffoldReadContract 默认按区块自动刷新）
  const { data: orderCountData } = useScaffoldReadContract({ contractName: "Escrow", functionName: "orderCount" });

  // 订单 id = 事件里的 id ∪ [0, orderCount)，去重排序
  const eventIds = ((createdOrders ?? []) as CreatedEvent[]).map(e => e.args.id);
  const orderCount = Number(orderCountData ?? 0n);
  const ids = Array.from(new Set([...eventIds, ...Array.from({ length: orderCount }, (_, i) => BigInt(i))].map(String)))
    .map(BigInt)
    .sort((a, b) => (a < b ? -1 : 1));

  // Escrow 的地址 + ABI：批量读 getOrder 和付款 approve 都要用
  const { data: escrowInfo } = useDeployedContractInfo({ contractName: "Escrow" });

  // 每行用 getOrder 读当前状态；用 useReadContracts 一次批量读全部订单
  const { data: ordersResult, refetch: refetchOrders } = useReadContracts({
    contracts: ids.map(
      id =>
        ({
          address: escrowInfo?.address,
          abi: escrowInfo?.abi,
          functionName: "getOrder",
          args: [id],
        }) as any,
    ),
    query: { enabled: Boolean(escrowInfo) },
  });
  const orders: (Order | undefined)[] = (ordersResult ?? []).map(r => r?.result as Order | undefined);

  // 每个新区块都重读一遍，交易上链后状态自动刷新
  const { data: blockNumber } = useBlockNumber({ watch: true, chainId: selectedNetwork.id });
  useEffect(() => {
    refetchOrders();
  }, [blockNumber, refetchOrders]);

  return (
    <div className="flex flex-col gap-8 max-w-4xl mx-auto p-8">
      <RoleBanner address={address} arbiter={arbiter} orders={orders} />
      <CreateOrderForm />
      <div>
        <h2 className="text-2xl font-bold mb-4">订单列表（共 {ids.length} 单）</h2>
        {ids.length === 0 ? (
          <p className="text-base-content/60">还没有任何订单，先用上面的表单创建一个吧</p>
        ) : (
          <div className="flex flex-col gap-4">
            {ids.map((id, i) => (
              <OrderRow
                key={id.toString()}
                id={id}
                order={orders[i]}
                address={address}
                arbiter={arbiter}
                escrowAddress={escrowInfo?.address}
                onDone={refetchOrders}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 角色提示：按订单动态判断当前账户在本合约中是买家、卖家、仲裁人还是旁观者。
 * 一个账户可以在不同订单里分别当买家和卖家，所以按订单数量统计。
 */
function RoleBanner({
  address,
  arbiter,
  orders,
}: {
  address?: string;
  arbiter?: string;
  orders: (Order | undefined)[];
}) {
  if (!address) {
    return <div className="alert alert-warning shadow-lg">请先在右上角连接钱包，并切换到 POTOS Testnet</div>;
  }

  const lower = address.toLowerCase();
  const isArbiter = arbiter?.toLowerCase() === lower;
  const buyerCount = orders.filter(o => o && o.buyer.toLowerCase() === lower).length;
  const sellerCount = orders.filter(o => o && o.seller.toLowerCase() === lower).length;

  const roles = [
    ...(isArbiter ? ["仲裁人"] : []),
    ...(buyerCount > 0 ? [`买家（${buyerCount} 单）`] : []),
    ...(sellerCount > 0 ? [`卖家（${sellerCount} 单）`] : []),
  ];
  const role = roles.length > 0 ? roles.join("、") : "旁观者";

  return (
    <div className="alert shadow-lg">
      <div>
        <p>
          当前账户：<span className="font-mono">{shortAddr(address)}</span>
        </p>
        <p>
          在本合约中的角色：<b>{role}</b>　合约仲裁人：<span className="font-mono">{shortAddr(arbiter)}</span>
        </p>
      </div>
    </div>
  );
}

/** 创建订单表单：卖家地址、金额（个）、多少分钟后到期、描述 */
function CreateOrderForm() {
  const [seller, setSeller] = useState("");
  const [amount, setAmount] = useState("");
  const [minutes, setMinutes] = useState("");
  const [description, setDescription] = useState("");

  // 订单用哪种 ERC20 结算：FKWToken 的部署地址
  const { data: tokenInfo } = useDeployedContractInfo({ contractName: "FKWToken" });
  const { writeContractAsync: writeEscrow, isMining } = useScaffoldWriteContract({ contractName: "Escrow" });

  const ready = isAddress(seller) && Number(amount) > 0 && Number(minutes) > 0 && description.trim().length > 0;

  const handleCreate = async () => {
    if (!ready || !tokenInfo) return;
    try {
      // 金额："个" → 18 位精度最小单位；到期："N 分钟后" → unix 秒时间戳
      const amountWei = parseUnits(amount, TOKEN_DECIMALS);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + Math.floor(Number(minutes) * 60));
      const sellerAddr = seller as `0x${string}`;
      await writeEscrow({
        functionName: "createOrder",
        args: [sellerAddr, tokenInfo.address, amountWei, deadline, description.trim()],
      });
      setSeller("");
      setAmount("");
      setMinutes("");
      setDescription("");
    } catch (error) {
      // 错误提示由 useTransactor 统一弹出，这里只重置状态
      console.error(error);
    }
  };

  return (
    <div className="card bg-base-200 shadow-xl">
      <div className="card-body">
        <h2 className="card-title">创建订单</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="form-control w-full">
            <div className="label">
              <span className="label-text">卖家地址</span>
            </div>
            <input
              className="input input-bordered w-full"
              placeholder="0x…"
              value={seller}
              onChange={e => setSeller(e.target.value)}
            />
          </label>
          <label className="form-control w-full">
            <div className="label">
              <span className="label-text">金额（个 FKW）</span>
            </div>
            <input
              className="input input-bordered w-full"
              type="number"
              min="0"
              step="any"
              placeholder="30"
              value={amount}
              onChange={e => setAmount(e.target.value)}
            />
          </label>
          <label className="form-control w-full">
            <div className="label">
              <span className="label-text">多少分钟后到期</span>
            </div>
            <input
              className="input input-bordered w-full"
              type="number"
              min="1"
              placeholder="60"
              value={minutes}
              onChange={e => setMinutes(e.target.value)}
            />
          </label>
          <label className="form-control w-full">
            <div className="label">
              <span className="label-text">描述</span>
            </div>
            <input
              className="input input-bordered w-full"
              placeholder="例如：一本书"
              value={description}
              onChange={e => setDescription(e.target.value)}
            />
          </label>
        </div>
        <div className="card-actions justify-end">
          <button className="btn btn-primary" onClick={handleCreate} disabled={!ready || isMining}>
            {isMining ? "交易确认中…" : "创建订单"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 单个订单：显示 getOrder 详情，按角色 + 状态渲染按钮 */
function OrderRow({
  id,
  order,
  address,
  arbiter,
  escrowAddress,
  onDone,
}: {
  id: bigint;
  order?: Order;
  address?: string;
  arbiter?: string;
  escrowAddress?: string;
  onDone?: () => void;
}) {
  const { writeContractAsync: writeEscrow, isMining: escrowMining } = useScaffoldWriteContract({
    contractName: "Escrow",
  });
  const { writeContractAsync: writeToken } = useScaffoldWriteContract({ contractName: "FKWToken" });

  // 付款分两步：approve → deposit，用 step 展示当前进度并防止重复点击
  const [payStep, setPayStep] = useState<"idle" | "approve" | "deposit">("idle");

  if (!order) {
    return (
      <div className="card bg-base-200 shadow-xl">
        <div className="card-body">订单 #{id.toString()} 读取中…</div>
      </div>
    );
  }

  const lower = address?.toLowerCase();
  const isBuyer = lower === order.buyer.toLowerCase();
  const isSeller = lower === order.seller.toLowerCase();
  const isArbiter = arbiter !== undefined && lower === arbiter.toLowerCase();

  const status = order.status;
  const canPay = isBuyer && status === 0; // 买家 + Created
  const canConfirm = isBuyer && status === 1; // 买家 + Paid
  const canDispute = (isBuyer || isSeller) && status === 1; // 买卖任一方 + Paid
  // 合约要求 Disputed 状态才能 resolve，所以前端只在争议中给仲裁人显示按钮
  const canResolve = isArbiter && status === 4;

  /**
   * 付款必须拆成两笔交易：
   * 1) FKWToken.approve(escrow, amount)：授权 Escrow 扣款；
   * 2) Escrow.deposit(id)：Escrow 用 transferFrom 把代币从买家转到自己账上。
   * writeContractAsync 会等交易收到回执（上链确认）后才 resolve，
   * 所以 await 第一笔之后再发第二笔，保证 approve 已生效。
   */
  const handlePay = async () => {
    if (!escrowAddress) return;
    try {
      setPayStep("approve");
      // 第 1 笔：approve（等它上链确认）
      const approveTx = await writeToken({
        functionName: "approve",
        args: [escrowAddress as `0x${string}`, order.amount],
      });
      if (!approveTx) throw new Error("approve 未发出");
      setPayStep("deposit");
      // 第 2 笔：deposit（此时授权已生效）
      await writeEscrow({ functionName: "deposit", args: [id] });
      setPayStep("idle");
      onDone?.();
    } catch (error) {
      console.error(error);
      setPayStep("idle");
    }
  };

  const handleConfirm = async () => {
    try {
      await writeEscrow({ functionName: "confirm", args: [id] });
      onDone?.();
    } catch (error) {
      console.error(error);
    }
  };

  const handleDispute = async () => {
    try {
      await writeEscrow({ functionName: "dispute", args: [id] });
      onDone?.();
    } catch (error) {
      console.error(error);
    }
  };

  const handleResolve = async (sellerWins: boolean) => {
    try {
      await writeEscrow({ functionName: "resolve", args: [id, sellerWins] });
      onDone?.();
    } catch (error) {
      console.error(error);
    }
  };

  return (
    <div className="card bg-base-200 shadow-xl">
      <div className="card-body">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-lg font-bold">订单 #{id.toString()}</h3>
          <span className={`badge ${STATUS_BADGE[status]}`}>{STATUS_TEXT[status] ?? "未知"}</span>
          {order.description && <span className="text-base-content/70">“{order.description}”</span>}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
          <p>
            买家：<span className="font-mono">{shortAddr(order.buyer)}</span>
            {isBuyer && <span className="badge badge-sm ml-1">我</span>}
          </p>
          <p>
            卖家：<span className="font-mono">{shortAddr(order.seller)}</span>
            {isSeller && <span className="badge badge-sm ml-1">我</span>}
          </p>
          <p>金额：{formatUnits(order.amount, TOKEN_DECIMALS)} FKW</p>
          <p>截止时间：{fmtDeadline(order.deadline)}</p>
        </div>
        <div className="card-actions justify-end">
          {canPay && (
            <button
              className="btn btn-primary btn-sm"
              onClick={handlePay}
              disabled={payStep !== "idle" || escrowMining}
            >
              {payStep === "idle" && "付款（approve + deposit）"}
              {payStep === "approve" && "第 1/2 笔：approve 确认中…"}
              {payStep === "deposit" && "第 2/2 笔：deposit 发送中…"}
            </button>
          )}
          {canConfirm && (
            <button className="btn btn-success btn-sm" onClick={handleConfirm} disabled={escrowMining}>
              确认收货
            </button>
          )}
          {canDispute && (
            <button className="btn btn-warning btn-sm" onClick={handleDispute} disabled={escrowMining}>
              发起争议
            </button>
          )}
          {canResolve && (
            <>
              <button className="btn btn-success btn-sm" onClick={() => handleResolve(true)} disabled={escrowMining}>
                仲裁：判给卖家
              </button>
              <button className="btn btn-error btn-sm" onClick={() => handleResolve(false)} disabled={escrowMining}>
                仲裁：退款买家
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
