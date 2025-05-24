#!/bin/bash

# Script to attempt to fix "Error opening terminal: xterm-ghostty" on a remote machine.

echo "正在尝试解决 'Error opening terminal: xterm-ghostty' 问题..."
echo ""

# --- 方案一：安装 xterm-ghostty 的 terminfo ---
echo "[信息] 正在尝试为 xterm-ghostty 安装 terminfo..."

try_solution_2=false # 默认不尝试方案二，除非方案一失败

# 检查 tic 命令是否存在
if ! command -v tic &> /dev/null; then
    echo "[警告] 未找到 'tic' 命令。无法编译 terminfo。正在跳过方案一。"
    echo "        请尝试为您的发行版安装 'ncurses-bin' 或等效的软件包。"
    try_solution_2=true
else
    # Terminfo 源文件 URL (Ghostty 官方仓库)
    GHOSTTY_TERMINFO_URL="https://raw.githubusercontent.com/ghostty-org/ghostty/master/extra/ghostty.terminfo"
    TERMINFO_FILE_NAME="ghostty.terminfo"
    TMP_TERMINFO_PATH="/tmp/${TERMINFO_FILE_NAME}"
    USER_TERMINFO_DIR="${HOME}/.terminfo"

    # 检查 terminfo 是否已被识别
    if infocmp xterm-ghostty &> /dev/null; then
        echo "[成功] 'xterm-ghostty' 的 terminfo 似乎已被识别。"
        echo "        无需进一步操作。"
    else
        echo "[信息] infocmp 未找到 'xterm-ghostty'。正在尝试下载并安装。"
        # 创建用户 terminfo 目录 (如果不存在)
        mkdir -p "${USER_TERMINFO_DIR}"

        # 下载 terminfo 文件
        echo "[信息] 正在从 ${GHOSTTY_TERMINFO_URL} 下载 ${TERMINFO_FILE_NAME}..."
        if command -v curl &> /dev/null; then
            curl -sfL "${GHOSTTY_TERMINFO_URL}" -o "${TMP_TERMINFO_PATH}"
        elif command -v wget &> /dev/null; then
            wget -q "${GHOSTTY_TERMINFO_URL}" -O "${TMP_TERMINFO_PATH}"
        else
            echo "[错误] 未找到 'curl' 或 'wget' 命令。无法下载 terminfo 文件。"
            echo "        请安装 curl 或 wget，或手动下载 ${TERMINFO_FILE_NAME} 并运行 'tic -x ${TERMINFO_FILE_NAME}'。"
            try_solution_2=true # 尝试方案二
        fi

        if [[ -f "${TMP_TERMINFO_PATH}" ]] && [[ "$try_solution_2" != true ]]; then
            echo "[信息] 正在使用 'tic -x ${TMP_TERMINFO_PATH}' 编译并安装 terminfo..."
            if tic -x "${TMP_TERMINFO_PATH}"; then
                echo "[成功] Terminfo 已编译并安装到用户目录 (${USER_TERMINFO_DIR})。"
                # 验证
                if infocmp xterm-ghostty &> /dev/null; then
                    echo "[成功] 'xterm-ghostty' 现在可以被 infocmp 识别。"
                    echo "        请重新登录 SSH 或启动新的 SSH 会话使更改完全生效。"
                else
                    echo "[警告] Terminfo 编译似乎成功，但 'infocmp xterm-ghostty' 仍然失败。"
                    echo "         可能是 terminfo 文件或 'tic' 安装存在问题。"
                    try_solution_2=true
                fi
            else
                echo "[错误] 'tic -x ${TMP_TERMINFO_PATH}' 执行失败。"
                echo "        请确保 'ncurses-bin' (或等效软件包) 已正确安装并提供了可用的 'tic'。"
                try_solution_2=true
            fi
            rm -f "${TMP_TERMINFO_PATH}"
        elif [[ "$try_solution_2" != true ]]; then # 下载失败但 try_solution_2 未被设置
             echo "[错误] 下载 ${TERMINFO_FILE_NAME} 失败。"
             try_solution_2=true
        fi
    fi
fi

# --- 方案二：如果方案一失败或跳过，则向 Shell rc 文件添加回退机制 ---
if [[ "$try_solution_2" == true ]]; then
    echo ""
    echo "[信息] 正在尝试方案二：向 Shell 配置文件添加备用 TERM 设置..."

    SHELL_NAME=$(basename "$SHELL")
    RC_FILE=""

    if [[ "$SHELL_NAME" == "bash" ]]; then
        RC_FILE="${HOME}/.bashrc"
    elif [[ "$SHELL_NAME" == "zsh" ]]; then
        RC_FILE="${HOME}/.zshrc"
    else
        echo "[警告] 不支持的 Shell: $SHELL_NAME。无法自动配置备用 TERM。"
        echo "        如果问题仍然存在，请手动将以下内容添加到您的 Shell 启动文件中："
        echo '        if [[ "$TERM" == "xterm-ghostty" ]] && ! infocmp "$TERM" >/dev/null 2>&1; then'
        echo '          export TERM="xterm-256color"; # 或其他已知终端，如 "xterm"'
        echo '        fi'
        exit 1
    fi

    if [[ ! -f "$RC_FILE" ]]; then
        echo "[信息] Shell 配置文件 '$RC_FILE' 未找到。正在创建它。"
        touch "$RC_FILE"
    fi

    FALLBACK_CONFIG=$(cat <<'EOF'

# 为 xterm-ghostty 终端类型设置回退机制
if [[ "$TERM" == "xterm-ghostty" ]] && ! infocmp "$TERM" >/dev/null 2>&1; then
  # 尝试设置一个已知可用的 TERM 值
  if infocmp "xterm-256color" >/dev/null 2>&1; then
    export TERM="xterm-256color"
  elif infocmp "xterm" >/dev/null 2>&1; then # 如果 xterm-256color 不可用，尝试 xterm
    export TERM="xterm"
  elif infocmp "vt100" >/dev/null 2>&1; then # 作为最后的备选
    export TERM="vt100"
  else # 多数系统上不应发生
    echo "警告: infocmp 无法识别任何通用的备用 TERM (xterm-256color, xterm, vt100)。" >&2
  fi
fi
EOF
)

    # 检查是否已存在该配置
    if grep -q 'Fallback for xterm-ghostty terminal type' "$RC_FILE" || grep -q '回退机制' "$RC_FILE"; then
        echo "[信息] 备用配置似乎已存在于 '$RC_FILE'。"
    else
        echo "[信息] 正在向 '$RC_FILE' 添加备用配置..."
        # 创建备份
        cp "$RC_FILE" "${RC_FILE}.bak_$(date +%Y%m%d%H%M%S)"
        echo "$FALLBACK_CONFIG" >> "$RC_FILE"
        echo "[成功] 备用配置已添加。请运行 'source ${RC_FILE}' 或重新登录 SSH。"
    fi
else
    echo ""
    echo "[信息] 方案一似乎已成功，或者 'xterm-ghostty' 已被识别。正在跳过方案二。"
fi

echo ""
echo "问题解决尝试已完成。"
echo "如果重新登录或 source Shell 配置文件后问题仍然存在，可能需要进一步手动排查。"
