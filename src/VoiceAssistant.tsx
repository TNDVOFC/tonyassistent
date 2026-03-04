import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Mic, MicOff, Loader2, Volume2, VolumeX, MapPin } from 'lucide-react';
import { GoogleGenAI, Modality } from "@google/genai";

// Initialize Gemini API
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Types for Speech Recognition
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: (event: SpeechRecognitionEvent) => void;
  onerror: (event: any) => void;
  onend: () => void;
}

// Add to window type
declare global {
  interface Window {
    SpeechRecognition: any;
    webkitSpeechRecognition: any;
  }
}

type AssistantState = 'IDLE' | 'LISTENING_WAKE_WORD' | 'LISTENING_QUERY' | 'PROCESSING' | 'SPEAKING' | 'ERROR';

export default function VoiceAssistant() {
  const [state, setState] = useState<AssistantState>('IDLE');
  const stateRef = useRef<AssistantState>('IDLE'); // Ref to track state in callbacks
  const modeRef = useRef<AssistantState>('IDLE'); // Sync ref for immediate updates
  
  const [transcript, setTranscript] = useState('');
  const [response, setResponse] = useState('');
  const [error, setError] = useState('');
  
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const synthesisRef = useRef<SpeechSynthesis>(window.speechSynthesis);
  const [isMuted, setIsMuted] = useState(false);
  
  // Audio context for beeps
  const audioContextRef = useRef<AudioContext | null>(null);
  
  // Audio element for TTS playback
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const [location, setLocation] = useState<{lat: number, lng: number} | null>(null);

  // Update ref when state changes
  useEffect(() => {
    stateRef.current = state;
    modeRef.current = state;
  }, [state]);

  const playBeep = useCallback((frequency = 1000, duration = 0.1) => {
    if (isMuted) return;
    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      const ctx = audioContextRef.current;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = frequency;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.00001, ctx.currentTime + duration);
      osc.start();
      osc.stop(ctx.currentTime + duration);
    } catch (e) {
      console.error("Audio play failed", e);
    }
  }, [isMuted]);

  const startListeningWakeWord = useCallback(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setError("Seu navegador não suporta reconhecimento de voz.");
      return;
    }

    // Stop any existing recognition
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch(e) {}
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'pt-BR';

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let currentTranscript = '';
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        currentTranscript += event.results[i][0].transcript;
      }
      currentTranscript = currentTranscript.toLowerCase().trim();
      
      // Only update UI transcript if we are actually listening for wake word
      if (modeRef.current === 'LISTENING_WAKE_WORD') {
         // Optional: show what it hears? Maybe not to keep it clean.
         // setTranscript(currentTranscript); 
      }

      // Robust wake word detection using Regex with word boundaries
      // Matches: "ok tony", "okay tony", "ei tony", "oi tony", "olá tony", "hey tony"
      const wakeWordRegex = /\b(ok|okay|ei|oi|olá|hey)\s+tony\b/i;

      if (wakeWordRegex.test(currentTranscript)) {
        playBeep(800, 0.1);
        modeRef.current = 'LISTENING_QUERY'; // Sync update
        setState('LISTENING_QUERY');
        recognition.stop(); // Stop this instance
      }
    };

    recognition.onend = () => {
      // Only restart if we are still in wake word mode
      if (modeRef.current === 'LISTENING_WAKE_WORD') {
        setTimeout(() => {
          try { recognition.start(); } catch (e) {}
        }, 500);
      }
    };

    recognition.onerror = (event: any) => {
      if (event.error === 'not-allowed') {
        setError("Permissão de microfone negada.");
        setState('ERROR');
      }
    };

    recognitionRef.current = recognition;
    try { recognition.start(); } catch (e) {}
  }, [playBeep]);

  const processQuery = async (query: string) => {
    modeRef.current = 'PROCESSING';
    setState('PROCESSING');
    
    // Get current time and location context
    const now = new Date();
    const timeString = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const dateString = now.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    
    let context = `Informações em tempo real:\n- Data e Hora atual: ${dateString}, ${timeString}.\n`;
    if (location) {
      context += `- Localização do usuário (Lat/Long): ${location.lat}, ${location.lng}.\n`;
    }
    
    const fullQuery = `${context}\nUsuário: ${query}`;

    try {
      // Trying a lighter model to avoid quota limits
      const response = await ai.models.generateContent({
        model: "gemini-3.1-flash-lite-preview",
        contents: fullQuery,
        config: {
          systemInstruction: "Você é Tony, um assistente de IA útil e amigável. Suas respostas devem ser concisas, naturais e adequadas para serem faladas em voz alta. Responda sempre em Português do Brasil. Use o contexto de tempo e localização fornecido para responder perguntas sobre horas, data ou local."
        }
      });
      
      const text = response.text;
      if (text) {
        setResponse(text);
        await speak(text);
      } else {
        throw new Error("No response text");
      }
    } catch (err: any) {
      console.error("Gemini Error:", err);
      if (err.message && err.message.includes("429")) {
        setError("Limite de uso excedido. Tente novamente em alguns instantes.");
      } else {
        setError("Desculpe, não consegui processar isso.");
      }
      modeRef.current = 'LISTENING_WAKE_WORD';
      setState('LISTENING_WAKE_WORD');
    }
  };

  const startListeningQuery = useCallback(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'pt-BR';

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          const query = event.results[i][0].transcript;
          setTranscript(query);
          processQuery(query);
          return;
        } else {
          interim += event.results[i][0].transcript;
        }
      }
      setTranscript(interim);
    };

    recognition.onend = () => {
      // If we stopped and didn't process (e.g. silence), go back to wake word
      // We check modeRef to ensure we didn't already move to PROCESSING
      if (modeRef.current === 'LISTENING_QUERY') {
        modeRef.current = 'LISTENING_WAKE_WORD';
        setState('LISTENING_WAKE_WORD');
      }
    };
    
    recognition.onerror = (event: any) => {
       // If error, go back to wake word
       if (modeRef.current === 'LISTENING_QUERY') {
         modeRef.current = 'LISTENING_WAKE_WORD';
         setState('LISTENING_WAKE_WORD');
       }
    };

    recognitionRef.current = recognition;
    try { recognition.start(); } catch (e) {}
  }, []);

  const speak = useCallback(async (text: string) => {
    if (isMuted) {
        modeRef.current = 'LISTENING_WAKE_WORD';
        setState('LISTENING_WAKE_WORD');
        return;
    }
    
    // Stop any browser TTS
    synthesisRef.current.cancel();

    try {
      // Use Gemini TTS
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: text }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Kore' },
            },
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      
      if (!base64Audio) {
        throw new Error("No audio data received");
      }

      // Convert base64 to ArrayBuffer
      const binaryString = window.atob(base64Audio);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const arrayBuffer = bytes.buffer;

      // Initialize AudioContext if needed
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      const ctx = audioContextRef.current;

      // Resume context if suspended (browser policy)
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }

      // Decode and play
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      
      // Stop previous source if any? 
      // We don't track the source node in a ref currently, but we should probably 
      // to allow stopping it.
      // For now, let's just play.
      
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      
      source.onended = () => {
        modeRef.current = 'LISTENING_WAKE_WORD';
        setState('LISTENING_WAKE_WORD');
      };
      
      modeRef.current = 'SPEAKING';
      setState('SPEAKING');
      source.start(0);

    } catch (error) {
      console.error("TTS Error:", error);
      // Fallback to browser TTS if Gemini fails
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'pt-BR';
      utterance.onend = () => {
        modeRef.current = 'LISTENING_WAKE_WORD';
        setState('LISTENING_WAKE_WORD');
      };
      synthesisRef.current.speak(utterance);
    }
  }, [isMuted]);

  // Effect to handle state transitions for listening
  useEffect(() => {
    if (state === 'LISTENING_WAKE_WORD') {
      startListeningWakeWord();
    } else if (state === 'LISTENING_QUERY') {
      startListeningQuery();
    }
  }, [state, startListeningWakeWord, startListeningQuery]);

  // Screen Wake Lock
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  const requestWakeLock = async () => {
    try {
      if ('wakeLock' in navigator) {
        const wakeLock = await (navigator as any).wakeLock.request('screen');
        wakeLockRef.current = wakeLock;
        console.log('Wake Lock is active');
        wakeLock.addEventListener('release', () => {
          console.log('Wake Lock was released');
        });
      }
    } catch (err: any) {
      console.error(`${err.name}, ${err.message}`);
    }
  };

  const releaseWakeLock = async () => {
    if (wakeLockRef.current) {
      try {
        await wakeLockRef.current.release();
        wakeLockRef.current = null;
      } catch (err: any) {
        console.error(`${err.name}, ${err.message}`);
      }
    }
  };

  const handleStart = () => {
    modeRef.current = 'LISTENING_WAKE_WORD';
    setState('LISTENING_WAKE_WORD');
    requestWakeLock();
    
    // Request location
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          setLocation({
            lat: position.coords.latitude,
            lng: position.coords.longitude
          });
          console.log("Location acquired:", position.coords);
        },
        (error) => {
          console.error("Error getting location", error);
        }
      );
    }
  };

  const handleStop = () => {
    modeRef.current = 'IDLE';
    setState('IDLE');
    if (recognitionRef.current) recognitionRef.current.stop();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    releaseWakeLock();
  };

  return (
    <div className="min-h-screen bg-black text-white flex flex-col items-center justify-center p-4 relative overflow-hidden">
      {/* Background Ambient Glow */}
      <div className={`absolute inset-0 transition-opacity duration-1000 ${state === 'LISTENING_QUERY' || state === 'SPEAKING' ? 'opacity-30' : 'opacity-10'}`}>
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-blue-500 rounded-full blur-[100px]" />
      </div>

      {/* Main UI */}
      <div className="z-10 flex flex-col items-center gap-8 max-w-lg w-full text-center">
        
        {/* Status Indicator */}
        <div className="h-12 flex items-center justify-center">
          <AnimatePresence mode="wait">
            {state === 'IDLE' && (
              <motion.span 
                key="idle"
                initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
                className="text-gray-400 font-medium"
              >
                Toque para iniciar
              </motion.span>
            )}
            {state === 'LISTENING_WAKE_WORD' && (
              <motion.span 
                key="wake"
                initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
                className="text-blue-400 font-medium animate-pulse"
              >
                Diga "OK Tony"
              </motion.span>
            )}
            {state === 'LISTENING_QUERY' && (
              <motion.span 
                key="query"
                initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
                className="text-green-400 font-medium"
              >
                Ouvindo...
              </motion.span>
            )}
            {state === 'PROCESSING' && (
              <motion.span 
                key="processing"
                initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
                className="text-purple-400 font-medium flex items-center gap-2"
              >
                <Loader2 className="w-4 h-4 animate-spin" /> Pensando...
              </motion.span>
            )}
            {state === 'SPEAKING' && (
              <motion.span 
                key="speaking"
                initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
                className="text-white font-medium"
              >
                Falando...
              </motion.span>
            )}
          </AnimatePresence>
        </div>

        {/* Visualizer Orb */}
        <motion.div 
          className="relative w-32 h-32 flex items-center justify-center cursor-pointer"
          onClick={state === 'IDLE' ? handleStart : handleStop}
          animate={{ 
            scale: state === 'LISTENING_QUERY' ? [1, 1.2, 1] : state === 'SPEAKING' ? [1, 1.1, 1] : 1,
          }}
          transition={{ 
            repeat: Infinity, 
            duration: state === 'SPEAKING' ? 0.5 : 2,
            ease: "easeInOut"
          }}
        >
          {/* Core */}
          <div className={`absolute inset-0 rounded-full transition-colors duration-500 ${
            state === 'IDLE' ? 'bg-gray-800' :
            state === 'LISTENING_WAKE_WORD' ? 'bg-blue-600/50' :
            state === 'LISTENING_QUERY' ? 'bg-green-500' :
            state === 'PROCESSING' ? 'bg-purple-500' :
            state === 'SPEAKING' ? 'bg-white' : 'bg-red-500'
          } blur-md`} />
          
          {/* Rings */}
          <div className={`absolute inset-0 rounded-full border-2 border-white/20 ${state === 'LISTENING_WAKE_WORD' ? 'animate-ping' : ''}`} />
          
          {/* Icon */}
          <div className="relative z-10">
            {state === 'PROCESSING' ? (
              <Loader2 className="w-12 h-12 text-white animate-spin" />
            ) : (
              <Mic className={`w-12 h-12 ${state === 'IDLE' ? 'text-gray-500' : 'text-white'}`} />
            )}
          </div>
        </motion.div>

        {/* Transcript Display */}
        <div className="min-h-[100px] flex items-center justify-center px-4">
          <p className="text-2xl font-light text-white/90 leading-relaxed">
            {state === 'LISTENING_QUERY' ? transcript : 
             state === 'SPEAKING' ? response : 
             state === 'PROCESSING' ? transcript : ''}
          </p>
        </div>

        {/* Controls */}
        <div className="flex gap-4 mt-8">
          {state === 'IDLE' ? (
            <button 
              onClick={handleStart}
              className="px-8 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-full font-medium transition-colors flex items-center gap-2"
            >
              <Mic className="w-5 h-5" /> Iniciar Assistente
            </button>
          ) : (
            <button 
              onClick={handleStop}
              className="px-8 py-3 bg-red-600 hover:bg-red-500 text-white rounded-full font-medium transition-colors flex items-center gap-2"
            >
              <MicOff className="w-5 h-5" /> Parar
            </button>
          )}
        </div>

        {/* Error Message */}
        {error && (
          <div className="text-red-400 text-sm mt-4 bg-red-900/20 px-4 py-2 rounded-lg">
            {error}
          </div>
        )}
      </div>
      
      {/* Mute Toggle */}
      <div className="absolute top-4 right-4 flex gap-2">
        {location && (
          <div className="p-2 text-green-500/50" title="Localização ativa">
            <MapPin size={20} />
          </div>
        )}
        <button 
          onClick={() => setIsMuted(!isMuted)}
          className="p-2 text-white/50 hover:text-white transition-colors"
        >
          {isMuted ? <VolumeX /> : <Volume2 />}
        </button>
      </div>
    </div>
  );
}
