'use client'

import React, {
  CSSProperties,
  ImgHTMLAttributes,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'

interface ProgressiveImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  src: string
  fit?: 'contain' | 'cover'
  frameClassName?: string
  frameStyle?: CSSProperties
  imageClassName?: string
}

/**
 * Keep the final image invisible until the browser has downloaded and decoded
 * it. A semantic media-pipeline status occupies the stable frame in the
 * meantime, so progressive JPEG/PNG scanlines never reach the screen.
 */
export function ProgressiveImage({
  src,
  fit = 'contain',
  frameClassName = '',
  frameStyle,
  imageClassName = '',
  alt,
  onLoad,
  onError,
  ...imageProps
}: ProgressiveImageProps) {
  const [readySrc, setReadySrc] = useState<string | null>(null)
  const [errorSrc, setErrorSrc] = useState<string | null>(null)
  const [decodingSrc, setDecodingSrc] = useState<string | null>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const phase = readySrc === src
    ? 'ready'
    : errorSrc === src
      ? 'error'
      : decodingSrc === src
        ? 'decoding'
        : 'loading'
  const reveal = useCallback(async (image: HTMLImageElement) => {
    const requestedSrc = src
    setDecodingSrc(requestedSrc)
    try {
      await image.decode()
    } catch {
      // onLoad already proves the resource is usable; older Safari versions
      // may reject decode() for images they have nevertheless rendered.
    }
    if (imageRef.current === image && requestedSrc === src && image.naturalWidth > 0) {
      setReadySrc(requestedSrc)
      setErrorSrc(current => current === requestedSrc ? null : current)
      setDecodingSrc(current => current === requestedSrc ? null : current)
    }
  }, [src])

  useEffect(() => {
    const image = imageRef.current
    if (image?.complete && image.naturalWidth > 0) void reveal(image)
  }, [src, reveal])

  return (
    <span
      className={`pmo-progressive-image ${frameClassName}`}
      style={frameStyle}
      data-image-state={phase}
      data-image-fit={fit}
    >
      <span
        className="pmo-progressive-image-loader"
        style={{ opacity: phase === 'ready' || phase === 'error' ? 0 : 1 }}
        role={phase === 'loading' || phase === 'decoding' ? 'status' : undefined}
        aria-label={phase === 'decoding' ? '正在解码高清图像' : '正在获取高清图像'}
        aria-hidden={phase === 'ready' || phase === 'error'}
      >
        <span className="pmo-progressive-image-loader-composition" aria-hidden="true">
          <span className="pmo-progressive-image-loader-frame">
            <i data-cell="a" />
            <i data-cell="b" />
            <i data-cell="c" />
            <i data-cell="d" />
            <i data-cell="e" />
            <i data-cell="f" />
            <i data-cell="g" />
          </span>
          <span className="pmo-progressive-image-loader-focus" />
        </span>
      </span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        {...imageProps}
        ref={imageRef}
        src={src}
        alt={alt}
        decoding={imageProps.decoding ?? 'async'}
        className={`pmo-progressive-image-final ${imageClassName}`}
        style={{ ...imageProps.style, opacity: phase === 'ready' ? 1 : 0 }}
        onLoad={event => {
          void reveal(event.currentTarget)
          onLoad?.(event)
        }}
        onError={event => {
          setErrorSrc(src)
          setDecodingSrc(current => current === src ? null : current)
          onError?.(event)
        }}
      />
      {phase === 'error' && (
        <span className="pmo-progressive-image-error" role="img" aria-label="图片加载失败">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 5.75A1.75 1.75 0 0 1 5.75 4h12.5A1.75 1.75 0 0 1 20 5.75v12.5A1.75 1.75 0 0 1 18.25 20H5.75A1.75 1.75 0 0 1 4 18.25V5.75Zm2 11.9h12l-3.55-4.1a.75.75 0 0 0-1.1-.04l-1.65 1.7-2.45-2.7a.75.75 0 0 0-1.1-.01L6 14.72v2.93Zm8.6-7.4a1.35 1.35 0 1 0 0-2.7 1.35 1.35 0 0 0 0 2.7Z" />
          </svg>
        </span>
      )}
    </span>
  )
}
