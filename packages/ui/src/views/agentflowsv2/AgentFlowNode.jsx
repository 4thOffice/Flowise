import PropTypes from 'prop-types'
import { useContext, memo, useState, useEffect } from 'react'
import { useSelector } from 'react-redux'
import { Handle, Position, useUpdateNodeInternals, NodeToolbar } from 'reactflow'

// material-ui
import { styled, useTheme, alpha, darken, lighten } from '@mui/material/styles'
import { ButtonGroup, Avatar, Box, Typography, IconButton, Tooltip } from '@mui/material'

// project imports
import MainCard from '@/ui-component/cards/MainCard'
import { flowContext } from '@/store/context/ReactFlowContext'
import NodeInfoDialog from '@/ui-component/dialog/NodeInfoDialog'
import { ExecutionOrderContext } from './ExecutionOrderContext'

// icons
import {
    IconCheck,
    IconExclamationMark,
    IconCircleChevronRightFilled,
    IconCopy,
    IconTrash,
    IconInfoCircle,
    IconLoader,
    IconAlertCircleFilled,
    IconCode,
    IconWorldWww,
    IconPhoto,
    IconBrandGoogle,
    IconBrowserCheck
} from '@tabler/icons-react'
import StopCircleIcon from '@mui/icons-material/StopCircle'
import CancelIcon from '@mui/icons-material/Cancel'

// const
import { baseURL, AGENTFLOW_ICONS } from '@/store/constant'

const CardWrapper = styled(MainCard)(({ theme }) => ({
    background: theme.palette.card.main,
    color: theme.darkTextPrimary,
    border: 'solid 1px',
    width: 'max-content',
    height: 'auto',
    padding: '10px',
    boxShadow: 'none'
}))

const StyledNodeToolbar = styled(NodeToolbar)(({ theme }) => ({
    backgroundColor: theme.palette.card.main,
    color: theme.darkTextPrimary,
    padding: '5px',
    borderRadius: '10px',
    boxShadow: '0 2px 14px 0 rgb(32 40 45 / 8%)'
}))

// ===========================|| CANVAS NODE ||=========================== //

const AgentFlowNode = ({ id, data }) => {
    const theme = useTheme()
    const customization = useSelector((state) => state.customization)
    const canvas = useSelector((state) => state.canvas)
    const updateNodeInternals = useUpdateNodeInternals()
    const [isHovered, setIsHovered] = useState(false)
    const [warningMessage, setWarningMessage] = useState('')
    const { deleteNode, duplicateNode } = useContext(flowContext)
    const { showExecutionOrder, waveMap } = useContext(ExecutionOrderContext)
    const waveInfo = showExecutionOrder ? waveMap?.[id ?? data?.id] : null
    const [showInfoDialog, setShowInfoDialog] = useState(false)
    const [infoDialogProps, setInfoDialogProps] = useState({})

    const defaultColor = '#666666' // fallback color if data.color is not present
    const nodeColor = data.color || defaultColor

    // Get different shades of the color based on state
    const getStateColor = () => {
        if (data.selected) return nodeColor
        if (isHovered) return alpha(nodeColor, 0.8)
        return alpha(nodeColor, 0.5)
    }

    const getOutputAnchors = () => {
        return data.outputAnchors ?? []
    }

    // Percent of the node's height, so nothing is measured in render. Don't call `updateNodeInternals` from render:
    // it always reports new dimensions, which replaces `nodes` and re-renders the canvas.
    const getAnchorPosition = (index) => `${((index + 1) * 100) / (getOutputAnchors().length + 1)}%`

    const getMinimumHeight = () => {
        const outputCount = getOutputAnchors().length
        // Use exactly 60px as minimum height
        return Math.max(60, outputCount * 20 + 40)
    }

    const getBackgroundColor = () => {
        if (customization.isDarkMode) {
            return isHovered ? darken(nodeColor, 0.7) : darken(nodeColor, 0.8)
        }
        return isHovered ? lighten(nodeColor, 0.8) : lighten(nodeColor, 0.9)
    }

    const getStatusBackgroundColor = (status) => {
        switch (status) {
            case 'ERROR':
                return theme.palette.error.dark
            case 'INPROGRESS':
                return theme.palette.warning.dark
            case 'STOPPED':
            case 'TERMINATED':
                return theme.palette.error.main
            case 'FINISHED':
                return theme.palette.success.dark
            default:
                return theme.palette.primary.dark
        }
    }

    const renderIcon = (node) => {
        const foundIcon = AGENTFLOW_ICONS.find((icon) => icon.name === node.name)

        if (!foundIcon) return null
        return <foundIcon.icon size={24} color={'white'} />
    }

    const getBuiltInOpenAIToolIcon = (toolName) => {
        switch (toolName) {
            case 'web_search_preview':
                return <IconWorldWww size={14} color={'white'} />
            case 'code_interpreter':
                return <IconCode size={14} color={'white'} />
            case 'image_generation':
                return <IconPhoto size={14} color={'white'} />
            default:
                return null
        }
    }

    const getBuiltInGeminiToolIcon = (toolName) => {
        switch (toolName) {
            case 'urlContext':
                return <IconWorldWww size={14} color={'white'} />
            case 'googleSearch':
                return <IconBrandGoogle size={14} color={'white'} />
            case 'codeExecution':
                return <IconCode size={14} color={'white'} />
            default:
                return null
        }
    }

    const getBuiltInAnthropicToolIcon = (toolName) => {
        switch (toolName) {
            case 'web_search_20250305':
                return <IconWorldWww size={14} color={'white'} />
            case 'web_fetch_20250910':
                return <IconBrowserCheck size={14} color={'white'} />
            default:
                return null
        }
    }

    useEffect(() => {
        updateNodeInternals(data.id)
    }, [data, updateNodeInternals])

    useEffect(() => {
        const nodeOutdatedMessage = (oldVersion, newVersion) =>
            `Node version ${oldVersion} outdated\nUpdate to latest version ${newVersion}`
        const nodeVersionEmptyMessage = (newVersion) => `Node outdated\nUpdate to latest version ${newVersion}`

        const componentNode = canvas.componentNodes.find((nd) => nd.name === data.name)
        if (componentNode) {
            if (!data.version) {
                setWarningMessage(nodeVersionEmptyMessage(componentNode.version))
            } else if (data.version && componentNode.version > data.version) {
                setWarningMessage(nodeOutdatedMessage(data.version, componentNode.version))
            } else if (componentNode.badge === 'DEPRECATING') {
                setWarningMessage(
                    componentNode?.deprecateMessage ??
                        'This node will be deprecated in the next release. Change to a new node tagged with NEW'
                )
            } else if (componentNode.warning) {
                setWarningMessage(componentNode.warning)
            } else {
                setWarningMessage('')
            }
        }
    }, [canvas.componentNodes, data.name, data.version])

    return (
        <div onMouseEnter={() => setIsHovered(true)} onMouseLeave={() => setIsHovered(false)}>
            <StyledNodeToolbar>
                <ButtonGroup sx={{ gap: 1 }} variant='outlined' aria-label='Basic button group'>
                    {data.name !== 'startAgentflow' && (
                        <IconButton
                            size={'small'}
                            title='Duplicate'
                            onClick={() => {
                                duplicateNode(data.id)
                            }}
                            sx={{
                                color: customization.isDarkMode ? 'white' : 'inherit',
                                '&:hover': {
                                    color: theme.palette.primary.main
                                }
                            }}
                        >
                            <IconCopy size={20} />
                        </IconButton>
                    )}
                    <IconButton
                        size={'small'}
                        title='Delete'
                        onClick={() => {
                            deleteNode(data.id)
                        }}
                        sx={{
                            color: customization.isDarkMode ? 'white' : 'inherit',
                            '&:hover': {
                                color: theme.palette.error.main
                            }
                        }}
                    >
                        <IconTrash size={20} />
                    </IconButton>
                    <IconButton
                        size={'small'}
                        title='Info'
                        onClick={() => {
                            setInfoDialogProps({ data })
                            setShowInfoDialog(true)
                        }}
                        sx={{
                            color: customization.isDarkMode ? 'white' : 'inherit',
                            '&:hover': {
                                color: theme.palette.info.main
                            }
                        }}
                    >
                        <IconInfoCircle size={20} />
                    </IconButton>
                </ButtonGroup>
            </StyledNodeToolbar>
            <CardWrapper
                content={false}
                sx={{
                    borderColor: getStateColor(),
                    borderWidth: '1px',
                    boxShadow: data.selected ? `0 0 0 1px ${getStateColor()} !important` : 'none',
                    minHeight: getMinimumHeight(),
                    height: 'auto',
                    backgroundColor: getBackgroundColor(),
                    display: 'flex',
                    alignItems: 'center',
                    '&:hover': {
                        boxShadow: data.selected ? `0 0 0 1px ${getStateColor()} !important` : 'none'
                    }
                }}
                border={false}
            >
                {data && data.status && (
                    <Tooltip title={data.status === 'ERROR' ? data.error || 'Error' : ''}>
                        <Avatar
                            variant='rounded'
                            sx={{
                                ...theme.typography.smallAvatar,
                                borderRadius: '50%',
                                background:
                                    data.status === 'STOPPED' || data.status === 'TERMINATED'
                                        ? 'white'
                                        : getStatusBackgroundColor(data.status),
                                color: 'white',
                                ml: 2,
                                position: 'absolute',
                                top: -10,
                                right: -10
                            }}
                        >
                            {data.status === 'INPROGRESS' ? (
                                <IconLoader className='spin-animation' />
                            ) : data.status === 'ERROR' ? (
                                <IconExclamationMark />
                            ) : data.status === 'TERMINATED' ? (
                                <CancelIcon sx={{ color: getStatusBackgroundColor(data.status) }} />
                            ) : data.status === 'STOPPED' ? (
                                <StopCircleIcon sx={{ color: getStatusBackgroundColor(data.status) }} />
                            ) : (
                                <IconCheck />
                            )}
                        </Avatar>
                    </Tooltip>
                )}

                {warningMessage && (
                    <Tooltip placement='right-start' title={<span style={{ whiteSpace: 'pre-line' }}>{warningMessage}</span>}>
                        <Avatar
                            variant='rounded'
                            sx={{
                                ...theme.typography.smallAvatar,
                                borderRadius: '50%',
                                background: 'white',
                                position: 'absolute',
                                top: -10,
                                left: -10
                            }}
                        >
                            <IconAlertCircleFilled color='orange' />
                        </Avatar>
                    </Tooltip>
                )}

                <Box sx={{ width: '100%' }}>
                    {!data.hideInput && (
                        <Handle
                            type='target'
                            position={Position.Left}
                            id={data.id}
                            style={{
                                width: 5,
                                height: 20,
                                backgroundColor: 'transparent',
                                border: 'none',
                                position: 'absolute',
                                left: -2
                            }}
                        >
                            <div
                                style={{
                                    width: 5,
                                    height: 20,
                                    backgroundColor: nodeColor,
                                    position: 'absolute',
                                    left: '50%',
                                    top: '50%',
                                    transform: 'translate(-50%, -50%)'
                                }}
                            />
                        </Handle>
                    )}

                    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
                        <Box item style={{ width: 50 }}>
                            {data.color && !data.icon ? (
                                <div
                                    style={{
                                        ...theme.typography.commonAvatar,
                                        ...theme.typography.largeAvatar,
                                        borderRadius: '15px',
                                        backgroundColor: data.color,
                                        cursor: 'grab',
                                        display: 'flex',
                                        justifyContent: 'center',
                                        alignItems: 'center',
                                        background: data.color
                                    }}
                                >
                                    {renderIcon(data)}
                                </div>
                            ) : (
                                <div
                                    style={{
                                        ...theme.typography.commonAvatar,
                                        ...theme.typography.largeAvatar,
                                        borderRadius: '50%',
                                        backgroundColor: 'white',
                                        cursor: 'grab'
                                    }}
                                >
                                    <img
                                        style={{ width: '100%', height: '100%', padding: 5, objectFit: 'contain' }}
                                        src={`${baseURL}/api/v1/node-icon/${data.name}`}
                                        alt={data.name}
                                    />
                                </div>
                            )}
                        </Box>
                        <Box>
                            <Typography
                                sx={{
                                    fontSize: '0.85rem',
                                    fontWeight: 500
                                }}
                            >
                                {data.label}
                            </Typography>

                            {waveInfo && (
                                <Tooltip title={waveInfo.tooltip} placement='bottom' arrow>
                                    <Box
                                        data-testid='execution-wave-badge'
                                        sx={{
                                            mt: 0.5,
                                            px: 0.75,
                                            py: 0.2,
                                            borderRadius: '10px',
                                            width: 'max-content',
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            fontSize: '0.68rem',
                                            fontWeight: 600,
                                            lineHeight: 1.25,
                                            whiteSpace: 'nowrap',
                                            border: '1px solid',
                                            ...(waveInfo.unreachable
                                                ? {
                                                      backgroundColor: alpha(
                                                          theme.palette.warning.main,
                                                          customization.isDarkMode ? 0.2 : 0.16
                                                      ),
                                                      borderColor: alpha(customization.isDarkMode ? '#fbbf24' : '#d97706', 0.45),
                                                      color: customization.isDarkMode ? '#fcd34d' : '#92400e'
                                                  }
                                                : waveInfo.isParallel
                                                ? {
                                                      backgroundColor: alpha(
                                                          customization.isDarkMode ? '#38bdf8' : '#0284c7',
                                                          customization.isDarkMode ? 0.22 : 0.12
                                                      ),
                                                      borderColor: alpha(customization.isDarkMode ? '#38bdf8' : '#0284c7', 0.4),
                                                      color: customization.isDarkMode ? '#7dd3fc' : '#0369a1'
                                                  }
                                                : {
                                                      backgroundColor: alpha(
                                                          customization.isDarkMode ? '#60a5fa' : '#2563eb',
                                                          customization.isDarkMode ? 0.22 : 0.1
                                                      ),
                                                      borderColor: alpha(customization.isDarkMode ? '#60a5fa' : '#2563eb', 0.4),
                                                      color: customization.isDarkMode ? '#bfdbfe' : '#1d4ed8'
                                                  })
                                        }}
                                    >
                                        {waveInfo.label}
                                    </Box>
                                </Tooltip>
                            )}

                            {(() => {
                                // Array of model configs to check and render
                                const modelConfigs = [
                                    { model: data.inputs?.llmModel, config: data.inputs?.llmModelConfig },
                                    { model: data.inputs?.agentModel, config: data.inputs?.agentModelConfig },
                                    { model: data.inputs?.conditionAgentModel, config: data.inputs?.conditionAgentModelConfig }
                                ]

                                // Filter out undefined models and render each valid one
                                return modelConfigs
                                    .filter((item) => item.model && item.config)
                                    .map((item, index) => (
                                        <Box key={`model-${index}`} sx={{ display: 'flex', gap: 1, mt: 1 }}>
                                            <Box
                                                sx={{
                                                    backgroundColor: customization.isDarkMode
                                                        ? 'rgba(255, 255, 255, 0.2)'
                                                        : 'rgba(255, 255, 255, 0.9)',
                                                    borderRadius: '16px',
                                                    width: 'max-content',
                                                    height: 24,
                                                    pl: 1,
                                                    pr: 1,
                                                    display: 'flex',
                                                    justifyContent: 'center',
                                                    alignItems: 'center'
                                                }}
                                            >
                                                <img
                                                    style={{ width: 20, height: 20, objectFit: 'contain' }}
                                                    src={`${baseURL}/api/v1/node-icon/${item.model}`}
                                                    alt={item.model}
                                                />
                                                <Typography sx={{ fontSize: '0.7rem', ml: 0.5 }}>
                                                    {item.config.modelName || item.config.model}
                                                </Typography>
                                            </Box>
                                        </Box>
                                    ))
                            })()}

                            {(() => {
                                // Array of tool configurations to check and render
                                const toolConfigs = [
                                    { tools: data.inputs?.llmTools, toolProperty: 'llmSelectedTool' },
                                    { tools: data.inputs?.agentTools, toolProperty: 'agentSelectedTool' },
                                    {
                                        tools:
                                            data.inputs?.selectedTool ?? data.inputs?.toolAgentflowSelectedTool
                                                ? [{ selectedTool: data.inputs?.selectedTool ?? data.inputs?.toolAgentflowSelectedTool }]
                                                : [],
                                        toolProperty: ['selectedTool', 'toolAgentflowSelectedTool']
                                    },
                                    { tools: data.inputs?.agentKnowledgeVSEmbeddings, toolProperty: ['vectorStore', 'embeddingModel'] },
                                    {
                                        tools: data.inputs?.agentToolsBuiltInOpenAI
                                            ? (typeof data.inputs.agentToolsBuiltInOpenAI === 'string'
                                                  ? JSON.parse(data.inputs.agentToolsBuiltInOpenAI)
                                                  : data.inputs.agentToolsBuiltInOpenAI
                                              ).map((tool) => ({ builtInTool: tool }))
                                            : [],
                                        toolProperty: 'builtInTool',
                                        isBuiltInOpenAI: true
                                    },
                                    {
                                        tools: data.inputs?.agentToolsBuiltInGemini
                                            ? (typeof data.inputs.agentToolsBuiltInGemini === 'string'
                                                  ? JSON.parse(data.inputs.agentToolsBuiltInGemini)
                                                  : data.inputs.agentToolsBuiltInGemini
                                              ).map((tool) => ({ builtInTool: tool }))
                                            : [],
                                        toolProperty: 'builtInTool',
                                        isBuiltInGemini: true
                                    },
                                    {
                                        tools: data.inputs?.agentToolsBuiltInAnthropic
                                            ? (typeof data.inputs.agentToolsBuiltInAnthropic === 'string'
                                                  ? JSON.parse(data.inputs.agentToolsBuiltInAnthropic)
                                                  : data.inputs.agentToolsBuiltInAnthropic
                                              ).map((tool) => ({ builtInTool: tool }))
                                            : [],
                                        toolProperty: 'builtInTool',
                                        isBuiltInAnthropic: true
                                    }
                                ]

                                // Filter out undefined tools and render each valid collection
                                return toolConfigs
                                    .filter((config) => config.tools && config.tools.length > 0)
                                    .map((config, configIndex) => (
                                        <Box key={`tools-${configIndex}`} sx={{ display: 'flex', gap: 1, mt: 1 }}>
                                            {config.tools.flatMap((tool, toolIndex) => {
                                                if (Array.isArray(config.toolProperty)) {
                                                    return config.toolProperty
                                                        .filter((prop) => tool[prop])
                                                        .map((prop, propIndex) => {
                                                            const toolName = tool[prop]
                                                            return (
                                                                <Box
                                                                    key={`tool-${configIndex}-${toolIndex}-${propIndex}`}
                                                                    component='img'
                                                                    src={`${baseURL}/api/v1/node-icon/${toolName}`}
                                                                    alt={toolName}
                                                                    sx={{
                                                                        width: 20,
                                                                        height: 20,
                                                                        borderRadius: '50%',
                                                                        backgroundColor: 'rgba(255, 255, 255, 0.2)',
                                                                        padding: 0.3
                                                                    }}
                                                                />
                                                            )
                                                        })
                                                } else {
                                                    const toolName = tool[config.toolProperty]
                                                    if (!toolName) return []

                                                    // Handle built-in OpenAI tools with icons
                                                    if (config.isBuiltInOpenAI) {
                                                        const icon = getBuiltInOpenAIToolIcon(toolName)
                                                        if (!icon) return []

                                                        return [
                                                            <Box
                                                                key={`tool-${configIndex}-${toolIndex}`}
                                                                sx={{
                                                                    width: 20,
                                                                    height: 20,
                                                                    borderRadius: '50%',
                                                                    backgroundColor: customization.isDarkMode
                                                                        ? darken(data.color, 0.5)
                                                                        : darken(data.color, 0.2),
                                                                    display: 'flex',
                                                                    justifyContent: 'center',
                                                                    alignItems: 'center',
                                                                    padding: 0.2
                                                                }}
                                                            >
                                                                {icon}
                                                            </Box>
                                                        ]
                                                    }

                                                    // Handle built-in Gemini tools with icons
                                                    if (config.isBuiltInGemini) {
                                                        const icon = getBuiltInGeminiToolIcon(toolName)
                                                        if (!icon) return []

                                                        return [
                                                            <Box
                                                                key={`tool-${configIndex}-${toolIndex}`}
                                                                sx={{
                                                                    width: 20,
                                                                    height: 20,
                                                                    borderRadius: '50%',
                                                                    backgroundColor: customization.isDarkMode
                                                                        ? darken(data.color, 0.5)
                                                                        : darken(data.color, 0.2),
                                                                    display: 'flex',
                                                                    justifyContent: 'center',
                                                                    alignItems: 'center',
                                                                    padding: 0.2
                                                                }}
                                                            >
                                                                {icon}
                                                            </Box>
                                                        ]
                                                    }

                                                    // Handle built-in Anthropic tools with icons
                                                    if (config.isBuiltInAnthropic) {
                                                        const icon = getBuiltInAnthropicToolIcon(toolName)
                                                        if (!icon) return []

                                                        return [
                                                            <Box
                                                                key={`tool-${configIndex}-${toolIndex}`}
                                                                sx={{
                                                                    width: 20,
                                                                    height: 20,
                                                                    borderRadius: '50%',
                                                                    backgroundColor: customization.isDarkMode
                                                                        ? darken(data.color, 0.5)
                                                                        : darken(data.color, 0.2),
                                                                    display: 'flex',
                                                                    justifyContent: 'center',
                                                                    alignItems: 'center',
                                                                    padding: 0.2
                                                                }}
                                                            >
                                                                {icon}
                                                            </Box>
                                                        ]
                                                    }

                                                    return [
                                                        <Box
                                                            key={`tool-${configIndex}-${toolIndex}`}
                                                            component='img'
                                                            src={`${baseURL}/api/v1/node-icon/${toolName}`}
                                                            alt={toolName}
                                                            sx={{
                                                                width: 20,
                                                                height: 20,
                                                                borderRadius: '50%',
                                                                backgroundColor: 'rgba(255, 255, 255, 0.2)',
                                                                padding: 0.3
                                                            }}
                                                        />
                                                    ]
                                                }
                                            })}
                                        </Box>
                                    ))
                            })()}
                        </Box>
                    </div>
                    {getOutputAnchors().map((outputAnchor, index) => {
                        return (
                            <Handle
                                type='source'
                                position={Position.Right}
                                key={outputAnchor.id}
                                id={outputAnchor.id}
                                style={{
                                    height: 20,
                                    width: 20,
                                    top: getAnchorPosition(index),
                                    backgroundColor: 'transparent',
                                    border: 'none',
                                    position: 'absolute',
                                    right: -10,
                                    opacity: isHovered ? 1 : 0,
                                    transition: 'opacity 0.2s'
                                }}
                            >
                                <div
                                    style={{
                                        position: 'absolute',
                                        width: 20,
                                        height: 20,
                                        borderRadius: '50%',
                                        backgroundColor: theme.palette.background.paper, // or 'white'
                                        pointerEvents: 'none'
                                    }}
                                />
                                <IconCircleChevronRightFilled
                                    size={20}
                                    color={nodeColor}
                                    style={{
                                        pointerEvents: 'none',
                                        position: 'relative',
                                        zIndex: 1
                                    }}
                                />
                            </Handle>
                        )
                    })}
                </Box>
            </CardWrapper>
            <NodeInfoDialog show={showInfoDialog} dialogProps={infoDialogProps} onCancel={() => setShowInfoDialog(false)}></NodeInfoDialog>
        </div>
    )
}

AgentFlowNode.propTypes = {
    id: PropTypes.string,
    data: PropTypes.object
}

export default memo(AgentFlowNode)
