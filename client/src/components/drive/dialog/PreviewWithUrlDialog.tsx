import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

import { FileItem } from '@/types/types'

interface PreviewWithUrlDialogProps {
  previewFile: FileItem | null
  onCancel: () => void
  fileUrl: string | null
}

export default function Preview2Dialog({
  previewFile,
  onCancel,
}: PreviewWithUrlDialogProps) {
  if (!previewFile) return null

  return (
    <div className='flex items-center space-x-2'>
      <Dialog open={!!previewFile} onOpenChange={onCancel}>
        <DialogContent className='max-w-4xl'>
          <DialogHeader>
            <DialogTitle>{previewFile?.name}</DialogTitle>
          </DialogHeader>
          <div className='aspect-video'>
            <iframe
              src={`/api/files/preview/${previewFile?.id}`}
              className='h-full w-full border-0'
              title={`Preview of ${previewFile?.name}`}
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
