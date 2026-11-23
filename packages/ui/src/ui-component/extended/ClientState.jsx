import { useDispatch } from 'react-redux'
import { useState, useEffect } from 'react'
import PropTypes from 'prop-types'
import { enqueueSnackbar as enqueueSnackbarAction, closeSnackbar as closeSnackbarAction, SET_CHATFLOW } from '@/store/actions'

// material-ui
import { Button, Stack, Typography } from '@mui/material'
import { IconX } from '@tabler/icons-react'

// Project import
import { StyledButton } from '@/ui-component/button/StyledButton'
import { TooltipWithParser } from '@/ui-component/tooltip/TooltipWithParser'

// store
import useNotifier from '@/utils/useNotifier'

// API
import chatflowsApi from '@/api/chatflows'
import { SwitchInput } from '@/ui-component/switch/Switch'

const ClientState = ({ dialogProps, onConfirm }) => {
    const dispatch = useDispatch()

    useNotifier()

    const enqueueSnackbar = (...args) => dispatch(enqueueSnackbarAction(...args))
    const closeSnackbar = (...args) => dispatch(closeSnackbarAction(...args))

    const [errorMessage, setErrorMessage] = useState('')

    const [chatbotConfig, setChatbotConfig] = useState({})

    const onSave = async () => {
        try {
            const saveResp = await chatflowsApi.updateChatflow(dialogProps.chatflow.id, {
                chatbotConfig: JSON.stringify(chatbotConfig)
            })
            if (saveResp.data) {
                enqueueSnackbar({
                    message: 'Client State / Zero-Retention config Saved',
                    options: {
                        key: new Date().getTime() + Math.random(),
                        variant: 'success',
                        action: (key) => (
                            <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                                <IconX />
                            </Button>
                        )
                    }
                })
                dispatch({ type: SET_CHATFLOW, chatflow: saveResp.data })
                onConfirm?.()
            }
        } catch (error) {
            enqueueSnackbar({
                message: `Failed to save Client State / Zero-Retention config: ${
                    typeof error.response.data === 'object' ? error.response.data.message : error.response.data
                }`,
                options: {
                    key: new Date().getTime() + Math.random(),
                    variant: 'error',
                    persist: true,
                    action: (key) => (
                        <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                            <IconX />
                        </Button>
                    )
                }
            })
        }
    }

    useEffect(() => {
        if (dialogProps.chatflow) {
            let chatbotConfig = dialogProps.chatflow.chatbotConfig ? JSON.parse(dialogProps.chatflow.chatbotConfig) : {}
            if (!chatbotConfig.clientState) {
                chatbotConfig.clientState = {}
            }
            setChatbotConfig(chatbotConfig || {})

            if (chatbotConfig.clientStateError) {
                setErrorMessage(chatbotConfig.clientStateError)
            } else {
                setErrorMessage('')
            }
        }

        return () => {}
    }, [dialogProps])

    return (
        <Stack direction='column' spacing={2} sx={{ alignItems: 'start' }}>
            <Typography variant='h3'>
                Client Holds State
                <TooltipWithParser
                    style={{ mb: 1, mt: 2, marginLeft: 10 }}
                    title={
                        'Conversations always continue from the state token the client sends back with each request. These settings only control what the Flowise server records.'
                    }
                />
            </Typography>
            <Stack direction='column' spacing={2} sx={{ width: '100%' }}>
                <Stack direction='column' spacing={2}>
                    <Typography>Chat messages</Typography>
                    <SwitchInput
                        label='Disable recording chat messages'
                        onChange={() => {
                            if (!chatbotConfig?.clientState) return
                            chatbotConfig.clientState.enabled = !chatbotConfig.clientState.enabled
                        }}
                        value={chatbotConfig?.clientState?.enabled}
                    />
                </Stack>
                <Stack direction='column' spacing={2}>
                    <Typography>Executions</Typography>
                    <SwitchInput
                        label='Disable recording executions'
                        onChange={() => {
                            if (!chatbotConfig?.clientState) return
                            chatbotConfig.clientState.enabledFull = !chatbotConfig.clientState.enabledFull
                        }}
                        value={chatbotConfig?.clientState?.enabledFull}
                    />
                </Stack>
                <Stack direction='column' spacing={2}>
                    <Typography>
                        Conversation history
                        <TooltipWithParser
                            style={{ marginLeft: 10 }}
                            title={
                                'When on, the history field of a request is the conversation history for that turn instead of the one in the state token, and is saved in the token. Answers to approvals always continue on the token history. When off, the history field is ignored.'
                            }
                        />
                    </Typography>
                    <SwitchInput
                        label='Accept conversation history from the client'
                        onChange={() => {
                            if (!chatbotConfig?.clientState) return
                            chatbotConfig.clientState.acceptClientHistory = !chatbotConfig.clientState.acceptClientHistory
                        }}
                        value={chatbotConfig?.clientState?.acceptClientHistory}
                    />
                </Stack>

                {errorMessage && (
                    <Stack direction='column' spacing={1}>
                        {errorMessage}
                    </Stack>
                )}
            </Stack>
            <StyledButton variant='contained' onClick={onSave}>
                Save
            </StyledButton>
        </Stack>
    )
}

ClientState.propTypes = {
    dialogProps: PropTypes.object,
    onConfirm: PropTypes.func
}

export default ClientState
